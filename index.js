'use strict';
// homebridge-rti-inovattive
// Dynamic platform: opens a TCP server and waits for the "RTI HomeKit Bridge (Inovattive)" driver,
// which runs on the RTI processor. The driver sends the accessory list and the state of each one;
// the plugin creates the accessories in HomeKit and sends Apple Home commands back to the driver.
//
// Protocol (text, one message per line ending in \n, fields separated by |, texts with encodeURIComponent):
//   RTI -> plugin   HELLO|<driver version>|<system id>|<license 0/1>|<instance>
//                   ACC|<slot>|<type>|<name>|<extras k=v;k=v>     (repeated, one per accessory)
//                   END                                            (end of list: sync)
//                   ST|<slot>|<key>=<value>[|<key>=<value>...]
//                   LIC|<0/1>
//                   PING
//   plugin -> RTI   CMD|<slot>|<key>=<value>
//                   PONG
//                   GET                                            (asks for all states again)
// State keys: on (0/1), lvl (0-100), cur (temperature), set (setpoint), mode (0 off,1 heat,2 cool,3 auto), mute (0/1)
// Copyright 2026 Inovattive Home. MIT.

const net = require('net');

const PLUGIN_NAME = 'homebridge-rti-inovattive';
const PLATFORM_NAME = 'RTIInovattive';
const VERSION = require('./package.json').version;
const DEFAULT_PORT = 51888;
const MAX_BRIDGE_ACCESSORIES = 149;
const IDLE_TIMEOUT_MS = 120000;   // driver sends PING every 30 s; nothing for 2 min = dead connection

const TYPES = {
  light: 'Light',
  dimmer: 'Dimmer',
  switch: 'Switch',
  outlet: 'Outlet',
  fan: 'Fan',
  scene: 'Scene',
  lock: 'Lock',
  thermostat: 'Air conditioner',
  blind: 'Shade',
  contact: 'Contact sensor',
  motion: 'Motion sensor',
  receiver: 'Audio zone',
};

function dec(s) {
  try { return decodeURIComponent(String(s || '')); } catch (e) { return String(s || ''); }
}

function parseExtras(s) {
  const out = {};
  String(s || '').split(';').forEach((kv) => {
    const i = kv.indexOf('=');
    if (i > 0) out[kv.slice(0, i).trim()] = dec(kv.slice(i + 1));
  });
  return out;
}

function num(v, def) {
  const n = parseFloat(v);
  return isNaN(n) ? def : n;
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

class RtiPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.hap = api.hap;
    this.port = parseInt(this.config.port, 10) || DEFAULT_PORT;
    // one or more comma-separated IPs (one driver instance per processor)
    this.allowedIps = String(this.config.allowedIp || '').split(/[\s,;]+/).filter((x) => x.length);
    this.debug = !!this.config.debug;

    this.cached = new Map();     // UUID -> PlatformAccessory (from the Homebridge cache)
    this.slots = new Map();      // "<instance>:<slot>" -> { acc, inst, slot, type, name, extras, state }
    this.conns = new Map();      // instance -> session { sock, ip, inst, rx, pending, licensed }
    this.external = new Map();   // UUID -> accessory published outside the bridge (audio zone / TV)

    api.on('didFinishLaunching', () => this.start());
    api.on('shutdown', () => this.stop());
  }

  dbg(msg) { if (this.debug) this.log.info('[debug] ' + msg); }

  key(inst, slot) { return inst + ':' + slot; }
  tag(inst) { return inst > 1 || this.conns.size > 1 ? '[instance ' + inst + '] ' : ''; }

  // Called by Homebridge for each cached accessory, before didFinishLaunching
  configureAccessory(acc) {
    this.cached.set(acc.UUID, acc);
  }

  // ---------------------------------------------------------------- TCP server
  start() {
    // Cached accessories: attach handlers now (they answer "No Response" until the driver connects)
    for (const acc of this.cached.values()) {
      const c = acc.context || {};
      if (c.slot === undefined || !TYPES[c.type]) continue;
      const inst = parseInt(c.inst, 10) || 1;
      const entry = { acc, inst, slot: String(c.slot), type: c.type, name: c.name || acc.displayName, extras: c.extras || {}, state: {} };
      this.slots.set(this.key(inst, entry.slot), entry);
      this.setupAccessory(entry);
    }
    this.server = net.createServer((s) => this.onConnection(s));
    this.server.on('error', (e) => this.log.error('TCP server on port ' + this.port + ': ' + e.message));
    this.server.listen(this.port, () => {
      this.log.info('v' + VERSION + ' waiting for the RTI driver on TCP port ' + this.port +
        (this.allowedIps.length ? ' (only accepts ' + this.allowedIps.join(', ') + ')' : '') + '. Cached accessories: ' + this.slots.size);
    });
  }

  stop() {
    for (const c of this.conns.values()) { try { c.sock.destroy(); } catch (e) { /* ignore */ } }
    try { if (this.server) this.server.close(); } catch (e) { /* ignore */ }
  }

  onConnection(s) {
    const ip = String(s.remoteAddress || '').replace(/^::ffff:/, '');
    if (this.allowedIps.length && this.allowedIps.indexOf(ip) < 0) {
      this.log.warn('Connection refused from ' + ip + ' (configured to accept only ' + this.allowedIps.join(', ') + ')');
      s.destroy();
      return;
    }
    // the instance is only known at HELLO (first line from the driver)
    const sess = { sock: s, ip, inst: 0, rx: '', pending: null, licensed: true };
    s.setEncoding('utf8');
    s.setNoDelay(true);
    s.setKeepAlive(true, 30000);
    s.setTimeout(IDLE_TIMEOUT_MS);
    this.dbg('connection from ' + ip);
    s.on('data', (d) => this.onData(sess, d));
    s.on('timeout', () => { this.log.warn(this.tag(sess.inst) + 'RTI driver silent for ' + (IDLE_TIMEOUT_MS / 1000) + ' s: disconnecting'); s.destroy(); });
    s.on('error', (e) => this.dbg('socket: ' + e.message));
    s.on('close', () => {
      if (!sess.inst || this.conns.get(sess.inst) !== sess) return;
      this.conns.delete(sess.inst);
      this.log.warn(this.tag(sess.inst) + 'RTI driver disconnected (' + ip + '). Its accessories show "No Response" until it comes back.');
    });
  }

  send(sess, line) {
    if (!sess || sess.sock.destroyed) return false;
    this.dbg('TX ' + this.tag(sess.inst) + line);
    sess.sock.write(line + '\n');
    return true;
  }

  onData(sess, d) {
    sess.rx += d;
    if (sess.rx.length > 1000000) { this.log.error('Message from the driver too large: discarded'); sess.rx = ''; return; }
    let i;
    while ((i = sess.rx.indexOf('\n')) >= 0) {
      const line = sess.rx.slice(0, i).replace(/\r/g, '').trim();
      sess.rx = sess.rx.slice(i + 1);
      if (line.length) {
        try { this.onLine(sess, line); } catch (e) { this.log.error('Error handling "' + line + '": ' + (e && e.stack || e)); }
      }
    }
  }

  onLine(sess, line) {
    const f = line.split('|');
    const cmd = f[0];
    if (cmd !== 'PING') this.dbg('RX ' + this.tag(sess.inst) + line);
    if (cmd === 'PING') { this.send(sess, 'PONG'); return; }
    if (cmd === 'HELLO') {
      const inst = parseInt(f[4], 10) || 1;
      const old = this.conns.get(inst);
      if (old && old !== sess) {
        this.log.info(this.tag(inst) + 'New connection for instance ' + inst + ' (' + sess.ip + '): replaces the previous one (' + old.ip + ')');
        try { old.sock.destroy(); } catch (e) { /* ignore */ }
      }
      sess.inst = inst;
      this.conns.set(inst, sess);
      sess.licensed = f[3] !== '0';
      this.log.info(this.tag(inst) + 'RTI driver v' + dec(f[1]) + ' connected from ' + sess.ip + (f[2] ? ' (' + dec(f[2]) + ')' : '') +
        (inst > 1 ? ', instance ' + inst : '') + (sess.licensed ? '' : ' - UNLICENSED (trial mode)'));
      return;
    }
    if (!sess.inst) { this.dbg('message before HELLO ignored: ' + line); return; }
    switch (cmd) {
      case 'LIC':
        sess.licensed = f[1] !== '0';
        if (!sess.licensed) this.log.warn(this.tag(sess.inst) + 'RTI driver unlicensed: the trial period is over, RTI ignores Apple Home commands.');
        return;
      case 'ACC':
        if (!sess.pending) sess.pending = [];
        if (!TYPES[f[2]]) { this.log.warn('Unknown type for accessory ' + f[1] + ': ' + f[2]); return; }
        sess.pending.push({ slot: String(f[1]), type: f[2], name: dec(f[3]) || ('RTI ' + f[1]), extras: parseExtras(f[4]) });
        return;
      case 'END':
        this.syncList(sess.inst, sess.pending || []);
        sess.pending = null;
        return;
      case 'ST':
        this.onState(sess.inst, String(f[1]), f.slice(2));
        return;
      default:
        this.dbg('message ignored: ' + line);
    }
  }

  // ---------------------------------------------------------------- accessory list
  // Instance 1 keeps the v0.1 UUIDs (already paired accessories do not change)
  uuidFor(inst, slot, type) {
    return this.hap.uuid.generate(PLUGIN_NAME + ':' + (inst > 1 ? 'i' + inst + ':' : '') + slot + ':' + type);
  }

  syncList(inst, list) {
    const keep = new Set();
    const toRegister = [];
    let changed = 0;
    for (const item of list) {
      const uuid = this.uuidFor(inst, item.slot, item.type);
      keep.add(uuid);
      if (item.type === 'receiver') { this.syncExternal(inst, item, uuid); continue; }
      let acc = this.cached.get(uuid);
      const isNew = !acc;
      if (isNew) {
        acc = new this.api.platformAccessory(item.name, uuid, this.categoryFor(item.type));
        this.cached.set(uuid, acc);
        toRegister.push(acc);
      }
      const prev = acc.context || {};
      if (isNew || prev.name !== item.name || JSON.stringify(prev.extras || {}) !== JSON.stringify(item.extras)) changed++;
      acc.context = { inst, slot: item.slot, type: item.type, name: item.name, extras: item.extras };
      const k = this.key(inst, item.slot);
      const old = this.slots.get(k);
      const entry = { acc, inst, slot: item.slot, type: item.type, name: item.name, extras: item.extras,
        state: (old && old.acc === acc) ? old.state : {} };
      this.slots.set(k, entry);
      this.setupAccessory(entry);
    }
    // remove from HomeKit what left THIS instance's list (slot cleared or type changed)
    const gone = [];
    for (const [uuid, acc] of this.cached) {
      const ai = parseInt((acc.context || {}).inst, 10) || 1;
      if (ai === inst && !keep.has(uuid)) { gone.push(acc); this.cached.delete(uuid); }
    }
    for (const [k, e] of this.slots) {
      if (e.inst === inst && !keep.has(e.acc.UUID)) {
        if (e.type === 'receiver') this.log.warn(this.tag(inst) + 'Audio zone "' + e.name + '" left the list: remove it in the Home app (separately published accessory).');
        this.slots.delete(k);
      }
    }
    if (toRegister.length) this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, toRegister);
    if (gone.length) this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, gone);
    if (changed) this.api.updatePlatformAccessories([...this.cached.values()]);
    // HomeKit accepts at most 149 accessories behind one bridge (all RTI driver instances share this one)
    if (this.cached.size > MAX_BRIDGE_ACCESSORIES) {
      this.log.warn('This bridge now has ' + this.cached.size + ' accessories, above the HomeKit limit of ' + MAX_BRIDGE_ACCESSORIES +
        ': some may not appear in the Home app. Reduce the accessories sent by the RTI driver instances ("Send to Homebridge").');
    }
    this.log.info(this.tag(inst) + 'Driver list: ' + list.length + ' accessory(ies)' +
      (toRegister.length ? ', ' + toRegister.length + ' new' : '') +
      (gone.length ? ', ' + gone.length + ' removed' : ''));
    for (const item of list) this.log.info('  ' + (inst > 1 ? inst + '.' : '') + item.slot + ': ' + TYPES[item.type] + ' "' + item.name + '"');
  }

  // Audio zone = Television: HomeKit shows only one TV per bridge, so each zone is published
  // as a separate accessory (paired once in the Home app, same bridge code). Not cached.
  syncExternal(inst, item, uuid) {
    const k = this.key(inst, item.slot);
    let acc = this.external.get(uuid);
    const isNew = !acc;
    if (isNew) acc = new this.api.platformAccessory(item.name, uuid, this.hap.Categories.AUDIO_RECEIVER || this.hap.Categories.TELEVISION);
    acc.context = { inst, slot: item.slot, type: item.type, name: item.name, extras: item.extras };
    const old = this.slots.get(k);
    const entry = { acc, inst, slot: item.slot, type: item.type, name: item.name, extras: item.extras,
      state: (old && old.acc === acc) ? old.state : {} };
    this.slots.set(k, entry);
    this.setupAccessory(entry);
    if (isNew) {
      this.external.set(uuid, acc);
      this.api.publishExternalAccessories(PLUGIN_NAME, [acc]);
      this.log.info(this.tag(inst) + 'Audio zone "' + item.name + '" published: add it in the Home app (Add Accessory > More options) with the RTI bridge code.');
    }
  }

  categoryFor(type) {
    const C = this.hap.Categories;
    return {
      light: C.LIGHTBULB, dimmer: C.LIGHTBULB, switch: C.SWITCH, outlet: C.OUTLET, fan: C.FAN,
      scene: C.SWITCH, lock: C.DOOR_LOCK, thermostat: C.AIR_CONDITIONER || C.THERMOSTAT,
      blind: C.WINDOW_COVERING, contact: C.SENSOR, motion: C.SENSOR,
    }[type] || C.OTHER;
  }

  serviceTypeFor(type) {
    const S = this.hap.Service;
    return {
      light: S.Lightbulb, dimmer: S.Lightbulb, switch: S.Switch, outlet: S.Outlet, fan: S.Fan,
      scene: S.Switch, lock: S.LockMechanism, thermostat: S.Thermostat, blind: S.WindowCovering,
      contact: S.ContactSensor, motion: S.MotionSensor, receiver: S.Television,
    }[type];
  }

  // ---------------------------------------------------------------- services and handlers
  setupAccessory(e) {
    const { acc, type } = e;
    const S = this.hap.Service, C = this.hap.Characteristic;
    acc.getService(S.AccessoryInformation)
      .setCharacteristic(C.Manufacturer, 'RTI / Inovattive Home')
      .setCharacteristic(C.Model, TYPES[type])
      .setCharacteristic(C.SerialNumber, 'RTI-' + e.slot)
      .setCharacteristic(C.FirmwareRevision, VERSION);

    const ST = this.serviceTypeFor(type);
    // remove services of another type left over in the cache
    if (type !== 'receiver') {
      for (const sv of acc.services.slice()) {
        if (sv.UUID !== S.AccessoryInformation.UUID && sv.UUID !== ST.UUID) acc.removeService(sv);
      }
    }
    const sv = acc.getService(ST) || acc.addService(ST, e.name);
    sv.setCharacteristic(C.Name, e.name);
    if (C.ConfiguredName && !sv.testCharacteristic(C.ConfiguredName)) {
      try { sv.addOptionalCharacteristic(C.ConfiguredName); } catch (err) { /* older versions */ }
    }
    if (acc.displayName !== e.name) acc.displayName = e.name;
    e.service = sv;

    const get = (fn) => () => { this.requireOnline(e); return fn(); };
    const st = e.state;

    switch (type) {
      case 'light': case 'switch': case 'outlet': case 'fan': case 'dimmer':
        sv.getCharacteristic(C.On)
          .onGet(get(() => !!st.on))
          .onSet((v) => { this.command(e, 'on', v ? 1 : 0); st.on = !!v; });
        if (type === 'dimmer') {
          sv.getCharacteristic(C.Brightness)
            .onGet(get(() => clamp(Math.round(num(st.lvl, st.on ? 100 : 0)), 0, 100)))
            .onSet((v) => { this.command(e, 'lvl', Math.round(v)); st.lvl = v; st.on = v > 0; });
        }
        if (type === 'outlet' && C.OutletInUse) sv.getCharacteristic(C.OutletInUse).onGet(get(() => !!st.on));
        if (type === 'fan' && num(e.extras.speeds, 0) > 0) {
          const n = num(e.extras.speeds, 3);
          sv.getCharacteristic(C.RotationSpeed).setProps({ minValue: 0, maxValue: 100, minStep: 100 / n })
            .onGet(get(() => clamp(Math.round(num(st.lvl, st.on ? 100 : 0)), 0, 100)))
            .onSet((v) => { this.command(e, 'lvl', Math.round(v)); st.lvl = v; st.on = v > 0; });
        }
        break;

      case 'receiver': {
        sv.setCharacteristic(C.ConfiguredName, e.name);
        sv.setCharacteristic(C.SleepDiscoveryMode, C.SleepDiscoveryMode.ALWAYS_DISCOVERABLE);
        sv.getCharacteristic(C.Active)
          .onGet(get(() => (st.on ? C.Active.ACTIVE : C.Active.INACTIVE)))
          .onSet((v) => { this.command(e, 'on', v === C.Active.ACTIVE ? 1 : 0); st.on = v === C.Active.ACTIVE; });
        sv.getCharacteristic(C.ActiveIdentifier).onGet(() => 1).onSet(() => { /* single input */ });
        sv.getCharacteristic(C.RemoteKey).onSet((v) => {
          if (v === C.RemoteKey.PLAY_PAUSE) this.command(e, 'play', 1);
        });
        let input = acc.getServiceById(S.InputSource, 'streaming');
        if (!input) {
          input = acc.addService(S.InputSource, 'Streaming', 'streaming');
          sv.addLinkedService(input);
        }
        input.setCharacteristic(C.Identifier, 1)
          .setCharacteristic(C.ConfiguredName, 'Streaming')
          .setCharacteristic(C.IsConfigured, C.IsConfigured.CONFIGURED)
          .setCharacteristic(C.InputSourceType, C.InputSourceType.APPLICATION)
          .setCharacteristic(C.CurrentVisibilityState, C.CurrentVisibilityState.SHOWN);
        const spk = acc.getService(S.TelevisionSpeaker) || acc.addService(S.TelevisionSpeaker);
        spk.setCharacteristic(C.Active, C.Active.ACTIVE)
          .setCharacteristic(C.VolumeControlType, C.VolumeControlType.RELATIVE);
        spk.getCharacteristic(C.Mute)
          .onGet(get(() => !!st.mute))
          .onSet((v) => { this.command(e, 'mute', v ? 1 : 0); st.mute = !!v; });
        spk.getCharacteristic(C.VolumeSelector)
          .onSet((v) => { this.command(e, 'vol', v === C.VolumeSelector.INCREMENT ? 1 : -1); });
        e.speaker = spk;
        break;
      }

      case 'scene':
        sv.getCharacteristic(C.On)
          .onGet(get(() => false))
          .onSet((v) => {
            if (!v) return;
            this.command(e, 'on', 1);
            setTimeout(() => sv.updateCharacteristic(C.On, false), 1000);
          });
        break;

      case 'lock':
        sv.getCharacteristic(C.LockCurrentState)
          .onGet(get(() => (st.on === undefined ? C.LockCurrentState.UNKNOWN
            : (st.on ? C.LockCurrentState.SECURED : C.LockCurrentState.UNSECURED))));
        sv.getCharacteristic(C.LockTargetState)
          .onGet(get(() => (st.target !== undefined ? st.target
            : (st.on ? C.LockTargetState.SECURED : C.LockTargetState.UNSECURED))))
          .onSet((v) => { this.command(e, 'on', v === C.LockTargetState.SECURED ? 1 : 0); st.target = v; });
        break;

      case 'blind':
        sv.getCharacteristic(C.CurrentPosition).onGet(get(() => this.blindPos(st)));
        sv.getCharacteristic(C.TargetPosition)
          .onGet(get(() => (st.target !== undefined ? st.target : this.blindPos(st))))
          .onSet((v) => { this.command(e, 'lvl', Math.round(v)); st.target = v; });
        sv.getCharacteristic(C.PositionState).onGet(get(() => C.PositionState.STOPPED));
        break;

      case 'contact':
        sv.getCharacteristic(C.ContactSensorState)
          .onGet(get(() => (st.on ? C.ContactSensorState.CONTACT_NOT_DETECTED : C.ContactSensorState.CONTACT_DETECTED)));
        break;

      case 'motion':
        sv.getCharacteristic(C.MotionDetected).onGet(get(() => !!st.on));
        break;

      case 'thermostat': {
        const x = e.extras;
        const min = num(x.min, 16), max = num(x.max, 30), step = num(x.step, 1);
        const modes = String(x.modes || '0,1,2,3').split(',').map((m) => parseInt(m, 10)).filter((m) => m >= 0 && m <= 3);
        sv.getCharacteristic(C.TargetTemperature).setProps({ minValue: min, maxValue: max, minStep: step });
        sv.getCharacteristic(C.CurrentTemperature).setProps({ minValue: -20, maxValue: 60, minStep: 0.1 });
        sv.getCharacteristic(C.TargetHeatingCoolingState).setProps({ validValues: modes.length ? modes : [0, 2] });
        sv.getCharacteristic(C.CurrentTemperature).onGet(get(() => num(st.cur, num(st.set, 24))));
        sv.getCharacteristic(C.TargetTemperature)
          .onGet(get(() => clamp(num(st.set, 24), min, max)))
          .onSet((v) => { this.command(e, 'set', v); st.set = v; });
        sv.getCharacteristic(C.TargetHeatingCoolingState)
          .onGet(get(() => this.thermoMode(st, modes)))
          .onSet((v) => { this.command(e, 'mode', v); st.mode = v; });
        sv.getCharacteristic(C.CurrentHeatingCoolingState)
          .onGet(get(() => this.thermoCurrent(st, modes)));
        sv.getCharacteristic(C.TemperatureDisplayUnits)
          .onGet(() => C.TemperatureDisplayUnits.CELSIUS)
          .onSet(() => { /* Celsius only */ });
        break;
      }
    }
  }

  blindPos(st) {
    if (st.lvl !== undefined) return clamp(Math.round(num(st.lvl, 0)), 0, 100);
    return st.on ? 100 : 0;
  }

  thermoMode(st, modes) {
    const m = parseInt(st.mode, 10);
    if (!isNaN(m) && modes.indexOf(m) >= 0) return m;
    return 0;
  }

  // Current only accepts OFF/HEAT/COOL: AUTO shows as COOL when above the setpoint, otherwise HEAT
  thermoCurrent(st, modes) {
    const m = this.thermoMode(st, modes);
    if (m === 3) return num(st.cur, 0) > num(st.set, 0) ? 2 : 1;
    return m;
  }

  requireOnline(e) {
    const c = this.conns.get(e.inst);
    if (!c || c.sock.destroyed) {
      throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    return c;
  }

  command(e, key, value) {
    const c = this.requireOnline(e);
    this.log.info(this.tag(e.inst) + 'Apple Home -> RTI: ' + e.name + ' ' + key + '=' + value);
    this.send(c, 'CMD|' + e.slot + '|' + key + '=' + value);
  }

  // ---------------------------------------------------------------- state coming from RTI
  onState(inst, slot, pairs) {
    const e = this.slots.get(this.key(inst, slot));
    if (!e) { this.dbg('state for unknown slot ' + slot); return; }
    const st = e.state;
    for (const p of pairs) {
      const i = p.indexOf('=');
      if (i <= 0) continue;
      const k = p.slice(0, i), v = p.slice(i + 1);
      if (k === 'on') st.on = v === '1' || v === 'true';
      else if (k === 'lvl' || k === 'cur' || k === 'set') st[k] = num(v, undefined);
      else if (k === 'mode') st.mode = parseInt(v, 10);
      else if (k === 'mute') st.mute = v === '1' || v === 'true';
    }
    this.pushState(e);
  }

  pushState(e) {
    const C = this.hap.Characteristic, sv = e.service, st = e.state;
    if (!sv) return;
    switch (e.type) {
      case 'light': case 'switch': case 'outlet': case 'fan': case 'dimmer':
        sv.updateCharacteristic(C.On, !!st.on);
        if (e.type === 'dimmer' && st.lvl !== undefined) {
          const l = clamp(Math.round(st.lvl), 0, 100);
          if (l > 0) sv.updateCharacteristic(C.Brightness, l);
        }
        if (e.type === 'outlet' && C.OutletInUse) sv.updateCharacteristic(C.OutletInUse, !!st.on);
        if (e.type === 'fan' && num(e.extras.speeds, 0) > 0 && st.lvl !== undefined && st.lvl > 0) {
          sv.updateCharacteristic(C.RotationSpeed, clamp(Math.round(st.lvl), 0, 100));
        }
        break;
      case 'receiver':
        sv.updateCharacteristic(C.Active, st.on ? C.Active.ACTIVE : C.Active.INACTIVE);
        if (e.speaker) e.speaker.updateCharacteristic(C.Mute, !!st.mute);
        break;
      case 'lock': {
        const sec = st.on ? C.LockCurrentState.SECURED : C.LockCurrentState.UNSECURED;
        st.target = st.on ? C.LockTargetState.SECURED : C.LockTargetState.UNSECURED;
        sv.updateCharacteristic(C.LockCurrentState, sec);
        sv.updateCharacteristic(C.LockTargetState, st.target);
        break;
      }
      case 'blind': {
        const pos = this.blindPos(st);
        st.target = pos;
        sv.updateCharacteristic(C.CurrentPosition, pos);
        sv.updateCharacteristic(C.TargetPosition, pos);
        sv.updateCharacteristic(C.PositionState, C.PositionState.STOPPED);
        break;
      }
      case 'contact':
        sv.updateCharacteristic(C.ContactSensorState,
          st.on ? C.ContactSensorState.CONTACT_NOT_DETECTED : C.ContactSensorState.CONTACT_DETECTED);
        break;
      case 'motion':
        sv.updateCharacteristic(C.MotionDetected, !!st.on);
        break;
      case 'thermostat': {
        const x = e.extras;
        const min = num(x.min, 16), max = num(x.max, 30);
        const modes = String(x.modes || '0,1,2,3').split(',').map((m) => parseInt(m, 10));
        if (st.cur !== undefined) sv.updateCharacteristic(C.CurrentTemperature, st.cur);
        if (st.set !== undefined) sv.updateCharacteristic(C.TargetTemperature, clamp(st.set, min, max));
        sv.updateCharacteristic(C.TargetHeatingCoolingState, this.thermoMode(st, modes));
        sv.updateCharacteristic(C.CurrentHeatingCoolingState, this.thermoCurrent(st, modes));
        break;
      }
    }
  }
}

module.exports = (api) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, RtiPlatform);
};
