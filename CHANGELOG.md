# Changelog

## 1.0.2
- Package metadata: GitHub repository and issue tracker links, `supports-hap` keyword.
- config.schema.json: required fields declared as an array at the object level (JSON Schema).

## 1.0.1
- README: installation steps (Homebridge UI, child bridge, pairing, RTI driver setup) and Siri / Apple Home notes.

## 1.0.0
- Initial public release: lights, dimmers, switches, outlets, fans with speeds, scenes, locks, air conditioners / thermostats, shades, contact and motion sensors, audio zones (as TV, published as external accessories) and audio zone volume.
- Multiple RTI processors (one driver instance per processor) on the same plugin.
- Accessories report "No Response" while the RTI driver is disconnected.
