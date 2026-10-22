# homebridge-rti-inovattive

Brings items controlled by an **RTI** control system into Apple Home (HomeKit): lights, dimmers, switches,
outlets, fans, scenes, locks, air conditioners / thermostats, shades, contact and motion sensors, and audio zones.

Once published, every item can be controlled with **Siri** (iPhone, iPad, Apple Watch, HomePod, Mac, CarPlay) and used in
Home app rooms, scenes and automations, together with accessories from other brands.

It works together with the RTI driver **HomeKit Bridge (Inovattive)**, which runs on the RTI processor.
The driver connects to this plugin over TCP (default port 51888), sends the accessory list and the state of each
accessory, and receives Apple Home commands as driver events that the integrator programs in Integration Designer.

## Installation

1. In the Homebridge web UI (`http://<homebridge-ip>:8581`), open **Plugins**, search for
   `homebridge-rti-inovattive` (or "RTI") and click **Install**.
   From the command line: `hb-service add homebridge-rti-inovattive`.
2. In the plugin settings set **Name** = `RTI` and **TCP port** = `51888` (the same port as the RTI driver).
   Processor IPs are optional. Save.
3. On the plugin card open the three-dot menu > **Child Bridge Config**, turn on **Use Child Bridge**,
   save and restart Homebridge.
4. Open **Child Bridge Config** again to see the child bridge pairing QR code. In the Home app tap
   **+ > Add Accessory** and scan it. Do not use the QR code on the Homebridge home page: it belongs to the main bridge.
5. In RTI Integration Designer add the **HomeKit Bridge (Inovattive)** driver (one instance per RTI processor that
   has items for Apple Home), set **Homebridge IP address** and **Plugin TCP port** = `51888`, configure the
   accessories and download to the processor. The Homebridge log shows `RTI driver v... connected` and the accessory list.
6. Audio zones are shown as TVs. HomeKit allows only one TV per bridge, so each zone is published as a separate
   accessory: add each one in the Home app (**Add Accessory > More options**) with the same setup code.

A device should reach Apple Home through one path only: if a device controlled by the RTI processor also has its
own Homebridge plugin, use either that plugin or this one, never both at the same time.

## Settings

| Setting | Description |
|---|---|
| `name` | Platform name (default `RTI`). |
| `port` | TCP port the driver connects to (default `51888`). |
| `allowedIp` | Optional, comma-separated list of processor IPs allowed to connect. |
| `debug` | Logs every message exchanged with the driver. |

The RTI driver requires a license per system (30-minute trial after each processor restart without a key).

Inovattive Home — https://inovattivehome.com.br
