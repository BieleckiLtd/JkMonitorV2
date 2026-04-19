# Anenji ANJ-HHS Inverter — Complete Register Map

**Device**: Anenji ANJ-HHS-11000W-48V (Equipment type 0x7300 / 29440)  
**Protocol**: Modbus RTU over RS232, 9600 8N1, Slave ID 1  
**Firmware**: `7300_A0214122v31` (Protocol version 3)  
**Reference**: GM6200 Communication Protocol v2 (standard SMG-II)  
**Verified against**: Live device via `/dev/ttyAMA0` on `pi@fm.local` — April 2025

> **IMPORTANT**: The Anenji firmware uses a NON-STANDARD register layout.
> Standard SMG-II settings are at registers 300–420; this firmware relocates
> them to the 600+ range with *inconsistent* offsets.  The standard addresses
> (300, 301, etc.) are still readable and even accept writes, but they all
> read 0 and appear to be inactive shadows.

---

## Legend

| Column | Meaning |
|--------|---------|
| **Reg** | Modbus holding-register address |
| **Std** | Equivalent register in the standard GM6200 protocol |
| **R/W** | **R** = read-only, **W** = read/write, **Wm** = write rejected in current mode, **Wo** = write-only |
| **Value** | Value observed on live device at time of probe |
| **Verified** | ✅ = confirmed by LCD cross-check, 🔍 = inferred from standard protocol, ❓ = unknown |

---

## 1. Live Data — Status & Main (Data Source: `live_main`, addr 196, count 17)

| Reg | Std | R/W | Name | Unit / Scale | Value | Verified |
|-----|-----|-----|------|-------------|-------|----------|
| 196 | 200 | R | Equipment status word 1 | bitfield | — | 🔍 |
| 197 | 201 | R | Equipment status word 2 | bitfield | — | 🔍 |
| 198 | 202 | R | Grid voltage (alt) | ×0.1 V | 2144 (214.4V) | 🔍 |
| 199 | 203 | R | Grid frequency (alt) | ×0.01 Hz | — | 🔍 |
| 200 | 204 | R | AC charging power (alt) | W | 45120 | 🔍 |
| 201 | 205 | R | Operating mode | enum | 3 (Off-grid) | ✅ |
| 202 | — | R | Unknown | — | — | ❓ |
| 203 | 207 | R | Output frequency (alt) | ×0.01 Hz | 4988 (49.88Hz) | 🔍 |
| 204 | — | R | Unknown | — | — | ❓ |
| 205 | — | R | Unknown | — | — | ❓ |
| 206 | — | R | Unknown | — | — | ❓ |
| 207 | — | R | Unknown | — | — | ❓ |
| 208 | — | R | Unknown | — | — | ❓ |
| 209 | 209 | R | AC charging power | W | — | 🔍 |
| 210 | — | R | Unknown | — | — | ❓ |
| 211 | — | R | Unknown | — | — | ❓ |
| 212 | — | R | Unknown | — | — | ❓ |

> **Note**: Registers 196-212 partially overlap with the standard 200-214 live block
> but the mapping is shifted.  Entity `operating_mode` reads reg 201 (byteOffset 10).

---

## 2. Live Data — Solar & Load (Data Source: `live_solar`, addr 223, count 10)

| Reg | Std | R/W | Name | Unit / Scale | Value | Verified |
|-----|-----|-----|------|-------------|-------|----------|
| 223 | 223 | R | PV power | W | — | 🔍 |
| 224 | 224 | R | PV charging power | W | — | 🔍 |
| 225 | 225 | R | Load percent | % | — | 🔍 |
| 226 | — | R | Unknown | — | — | ❓ |
| 227 | 227 | R | Output frequency | ×0.01 Hz | — | 🔍 |
| 228 | — | R | Unknown | — | — | ❓ |
| 229 | — | R | Unknown | — | — | ❓ |
| 230 | — | R | Unknown | — | — | ❓ |
| 231 | 231 | R | INV temperature | °C | 19 | 🔍 |
| 232 | — | R | Unknown / reserved | — | — | ❓ |

---

## 3. Live Data — Battery (Data Source: `live_battery`, addr 277, count 5)

| Reg | Std | R/W | Name | Unit / Scale | Value | Verified |
|-----|-----|-----|------|-------------|-------|----------|
| 277 | 215 | R | Battery voltage | ×0.1 V | 533 (53.3V) | ✅ |
| 278 | 216 | R | Battery current | ×0.1 A (signed) | -14 (-1.4A) | ✅ |
| 279 | 217 | R | Battery power | W (signed) | -74 | ✅ |
| 280 | 218 | R | State of charge | % | 99 | ✅ |
| 281 | 219 | R | DC module temperature | °C | 12 | ✅ |

---

## 4. Live Data — PV Temperature (Data Source: `live_pv_temp`, addr 305, count 1)

| Reg | Std | R/W | Name | Unit / Scale | Value | Verified |
|-----|-----|-----|------|-------------|-------|----------|
| 305 | 229 | R | PV temperature | °C | 13 | ✅ |

---

## 5. Live Data — AC Measurements (Data Source: `live_ac`, addr 338, count 12)

| Reg | Std | R/W | Name | Unit / Scale | Value | Verified |
|-----|-----|-----|------|-------------|-------|----------|
| 338 | 202 | R | Grid voltage | ×0.1 V | 2371 (237.1V) | ✅ |
| 339 | 203 | R | Grid frequency | ×0.01 Hz | — | 🔍 |
| 340 | 204 | R | Grid power (signed) | W | — | 🔍 |
| 341 | — | R | Unknown | — | — | ❓ |
| 342 | — | R | Unknown | — | — | ❓ |
| 343 | — | R | Unknown | — | — | ❓ |
| 344 | — | R | Unknown | — | — | ❓ |
| 345 | — | R | Unknown | — | — | ❓ |
| 346 | 210 | R | Output voltage | ×0.1 V | — | 🔍 |
| 347 | 211 | R | Output current | ×0.1 A | — | 🔍 |
| 348 | 212 | R | Output active power | W | — | 🔍 |
| 349 | 213 | R | Output apparent power | VA | — | 🔍 |

---

## 6. Device Identity (Data Source: `info_id`, addr 171, count 22)

| Reg | Std | R/W | Name | Value | Verified |
|-----|-----|-----|------|-------|----------|
| 171 | 171 | R | Equipment type | 29440 (0x7300) | ✅ |
| 172–185 | — | R | Unknown / reserved | — | ❓ |
| 184 | 184 | R | Protocol version | 3 | ✅ |
| 186–192 | 186–192 | R | Serial number (ASCII) | 14 chars | ✅ |

---

## 7. Device Firmware (Data Source: `info_fw`, addr 691, count 71)

| Reg | Std | R/W | Name | Value | Verified |
|-----|-----|-----|------|-------|----------|
| 691 | 643 | R* | Rated power | 11000 W | ✅ |
| 692–693 | — | R | Unknown | — | ❓ |
| 694 | — | R | Unknown | 1 | ❓ |
| 695 | — | R | Unknown | 0 (ERR out-of-range) | ❓ |
| 696 | 434 | W | F3P01 — Time setting - Year | 2026 | 🔍 |
| 697 | 435 | W | F3P02 — Time setting - Month | 4 | 🔍 |
| 698 | 436 | W | F3P03 — Time setting - Day | 18 | 🔍 |
| 699 | 437 | W | F3P04 — Time setting - Hour | (changes) | 🔍 |
| 700 | 438 | W | F3P05 — Time setting - Minute | (changes) | 🔍 |
| 701 | 439 | W | F3P06 — Time setting - Second | (changes) | 🔍 |
| 702–707 | — | R | Unknown | 0 | ❓ |
| 708 | — | R | Unknown | 90 | ❓ |
| 709 | — | R | Unknown | 6 | ❓ |
| 710–749 | — | R | Reserved (all 0) | 0 | — |
| 750 | — | R | Unknown | 3770 | ❓ |
| 751–753 | — | R | Reserved (all 0) | 0 | — |
| 754–761 | 626–633 | R | Firmware version (ASCII) | `7300_A0214122v31` | ✅ |
| 762 | 643 | R | Rated power (duplicate) | 11000 W | 🔍 |
| 763 | 644 | R | Rated battery cells | 4 | 🔍 |

> \* Reg 691 accepted writes in the probe, but writing to rated power would be dangerous.

---

## 8. Settings — Complete Map (Data Source: `settings`, addr 601, count 90)

This is the core settings block. All settings use FC 0x03 for read. Confirmed
Modbus-writeable settings use FC 0x10 (write multiple, qty=1) or the app's
FC06 fallback where the firmware accepts it.

Registers 606 and 607 mirror the front-panel F1P03/F1P04 output voltage and
frequency selections, but live probing on this firmware shows they are not
Modbus-writeable: FC 0x10 returns exception 0x07 and FC 0x06 returns no reply.
They remain readable only in the app and device definition.

`Prog` uses the inverter front-panel program numbers from the user manual. `?`
marks a probable match that still needs LCD or write-path verification, and `—`
means the register is not exposed as a confirmed F0-F4 front-panel program.

### 8.0 Manual Program Index (F0–F4)

This index keeps the manual program numbering out of the UI while preserving it
in the register map.

| Group | Prog | Manual description | Register / entity | Notes |
|------|------|--------------------|-------------------|-------|
| F0 | P01 | AC input voltage range | 677 / `input_mode` | Confirmed |
| F0 | P02 | Power saving mode enable/disable | 681 / `energy_saving_mode` | Confirmed |
| F0 | P03 | Overload bypass | 684 / `overload_transfer_bypass` | Confirmed |
| F0 | P04 | Auto restart when overload occurs | 682 / `overload_auto_restart` | Confirmed |
| F0 | P05 | Auto restart when over temperature occurs | 683 / `over_temp_auto_restart` | Confirmed |
| F0 | P06 | Auto bypass | — | Not mapped in the current device definition |
| F0 | P07 | Auto return to default display screen | 678 / `lcd_auto_return` | Confirmed |
| F0 | P08 | Backlight control | 679 / `lcd_backlight` | Confirmed |
| F0 | P09 | Buzzer mode | 603 / `buzzer_mode` | Confirmed; physical register sits in the 600 block |
| F0 | P10 | Modbus ID setting | 865 / `modbus_address` | Confirmed live by slave switch probe |
| F0 | P16 | Dry contact mode | 689 / `dry_contact_mode` | Confirmed by live LCD toggle; previous 689/690 app mapping was swapped |
| F0 | — | Boot method | 406 / `boot_method` | Read-only mirror of the official datalogger boot-method text; direct writes to 406 were rejected |
| F0 | — | Automatic mains output enable | 690 / `automatic_mains_output_enable` | Confirmed live FC10-persistent control; best match for the official datalogger wording |
| F1 | P01 | Output source priority | 601 / `output_priority` | Confirmed |
| F1 | P02 | AC output mode | 600 | Confirmed; not exposed as a UI entity today |
| F1 | P03 | Output voltage | 606 / `output_voltage_setting` | LCD-side changes are mirrored here; the app now targets this register only when output/load is inactive |
| F1 | P04 | Output frequency | 607 / `output_frequency_setting` | LCD-side changes are mirrored here; the app now targets this register only when output/load is inactive |
| F1 | P06 | Slave output source priority | — | Manual feature present; live register still not confirmed |
| F1 | P07 | Slave output source priority start hour | — | Manual feature present; live register still not confirmed |
| F1 | P08 | Slave output source priority start minute | — | Manual feature present; live register still not confirmed |
| F1 | P09 | Slave output source priority end hour | — | Manual feature present; live register still not confirmed |
| F1 | P10 | Slave output source priority end minute | — | Manual feature present; live register still not confirmed |
| F1 | P11 | Second output (OP2) control | — | Manual feature present; live register still not confirmed |
| F1 | P12 | Second output (OP2) overload warning point | — | Manual feature present; live register still not confirmed |
| F1 | P13 | Second output (OP2) on timer - Hours | — | Manual feature present; live register still not confirmed |
| F1 | P14 | Second output (OP2) off timer - Hours | — | Manual feature present; live register still not confirmed |
| F2 | P01 | Battery type | 630 / `battery_type` | Confirmed |
| F2 | P02 | Charger source priority | 632 / `charge_priority` | Confirmed |
| F2 | P03 | Bulk charging voltage | 637 / `max_charge_voltage` | Confirmed |
| F2 | P04 | Floating charging voltage | 638 / `float_charge_voltage` | Confirmed |
| F2 | P05 | Back to utility source voltage / SOC | 644? / `mains_low_voltage_v` | Probable manual match |
| F2 | P06 | Back to battery mode voltage / SOC | 643? / `mains_discharge_recovery_v` | Probable manual match |
| F2 | P07 | Main output (OP1) cut-off voltage / SOC | 646? and 647? | Probable manual match |
| F2 | P08 | Second output (OP2) cut-off voltage / SOC | 649? and 650? | Probable manual match |
| F2 | P09 | Maximum charging current | 640 / `max_charge_current` | Confirmed |
| F2 | P10 | Maximum mains charging current | 641 / `max_mains_charge_current` | Confirmed |
| F2 | P11 | Slave charger source priority | — | Manual feature present; live register still not confirmed |
| F2 | P12 | Slave charger source priority start hour | — | Manual feature present; live register still not confirmed |
| F2 | P13 | Slave charger source priority start minute | — | Manual feature present; live register still not confirmed |
| F2 | P14 | Slave charger source priority end hour | — | Manual feature present; live register still not confirmed |
| F2 | P15 | Slave charger source priority end minute | — | Manual feature present; live register still not confirmed |
| F2 | P16 | Bulk charging time (C.V stage) | 639? / `constant_to_float_wait` | Probable manual match |
| F2 | P17 | Battery equalization | 656? | Probable manual match |
| F2 | P18 | Battery equalization voltage | 652 / `eq_charge_voltage` | Confirmed |
| F2 | P19 | Battery equalized time | 653 / `eq_time` | Confirmed |
| F2 | P20 | Battery equalized timeout | 654 / `eq_timeout` | Confirmed |
| F2 | P21 | Equalization interval | 655 / `eq_interval` | Confirmed |
| F2 | P22 | Equalization activated immediately | — | Manual feature present; live register still not confirmed |
| F2 | P23 | Manual activate the lithium battery setting | — | Manual feature present; live register still not confirmed |
| F2 | P24 | Automatic activation for lithium battery | — | Manual feature present; live register still not confirmed |
| F2 | P25 | Max battery discharge current setting | 642? / `max_discharge_current` | Probable manual match |
| F2 | P26 | Lithium battery activation time | — | Manual feature present; live register still not confirmed |
| F3 | P01 | Time setting - Year | 696 / `clock_year` | Confirmed |
| F3 | P02 | Time setting - Month | 697 / `clock_month` | Confirmed |
| F3 | P03 | Time setting - Day | 698 / `clock_day` | Confirmed |
| F3 | P04 | Time setting - Hour | 699 / `clock_hour` | Confirmed |
| F3 | P05 | Time setting - Minute | 700 / `clock_minute` | Confirmed |
| F3 | P06 | Time setting - Second | 701 / `clock_second` | Confirmed |
| F4 | P01 | Reset stored PV and output load energy data | 795 / `factory_reset` | Confirmed |

### 8.1 F1 Output Settings (regs 600–629)

| Reg | Std | R/W | Prog | Name | Values / Unit | Live Value | Verified |
|-----|-----|-----|------|------|--------------|------------|----------|
| 600 | 300 | Wm | F1P02 | AC output mode | 0=Single, 1=Parallel, 2–4=3-phase | 0 (Single) | 🔍 |
| 601 | 301 | **W** | **F1P01** | **Output source priority** | **1=SUB, 2=SBU, 3=SUF** | 2 (SBU) | **✅ LCD** |
| 602 | — | W | — | Unknown | — | 0 | ❓ |
| 603 | 303 | W | F0P09 | Buzzer mode | 0=Off, 1=Faults+warnings, 2=Faults only, 3=All | 0 (Off) | 🔍 |
| 604 | — | W | — | Unknown | — | 0 | ❓ |
| 605 | 402 | **R** | — | **Current output priority** (mirror of 601) | same as 601 | 2 (SBU) | **✅ LCD** |
| 606 | 320 | W? | F1P03 | Output voltage | ×0.1 V (2200/2300/2400) | 2300 (230V) | ✅ Live LCD mirror; app writes are guarded to output-off state |
| 607 | 321 | W? | F1P04 | Output frequency | ×0.01 Hz (5000/6000) | 5000 (50Hz) | ✅ Live LCD mirror; app writes are guarded to output-off state |
| 608–629 | — | W | — | Reserved / unused | all 0 | 0 | — |

### 8.2 F2 Battery Settings (regs 630–676)

| Reg | Std | R/W | Prog | Name | Values / Unit | Live Value | Verified |
|-----|-----|-----|------|------|--------------|------------|----------|
| 630 | 322 | W | F2P01 | Battery type | 0=AGM, 1=FLD, 2=USER, 3=Li1, 4=LiFePO4, 5=Li3, 6=Li4, 8=LIB | 4 (LiFePO4) | 🔍 |
| 631 | 323 | W | — | Battery overvoltage protection point | ×0.1 V | 590 (59.0V) | 🔍 |
| 632 | 331 | **W** | **F2P02** | **Charger source priority** | **1=SOF, 2=SNU, 3=OSO, 4=SOR** | 2 (SNU) | **✅ LCD** |
| 633 | 318? | W | — | Unknown (secondary output priority?) | — | 3 | ❓ |
| 634 | 319? | W | — | Unknown (secondary charge priority?) | — | 0 | ❓ |
| 635 | — | W | — | Unknown | — | 0 | ❓ |
| 636 | 403 | **R** | — | **Current charge priority** (mirror of 632) | same as 632 | 2 (SNU) | **✅ LCD** |
| 637 | 324 | W | F2P03 | Bulk charging voltage | ×0.1 V | 580 (58.0V) | 🔍 |
| 638 | 325 | W | F2P04 | Floating charging voltage | ×0.1 V | 564 (56.4V) | 🔍 |
| 639 | 330 | W | F2P16? | Bulk charging time / constant-to-float wait | minutes (1–900) | 0 | ❓ |
| 640 | 332 | W | F2P09 | Maximum charging current | ×0.1 A | 180 (18.0A) | 🔍 |
| 641 | 333 | W | F2P10 | Maximum mains charging current | ×0.1 A | 100 (10.0A) | 🔍 |
| 642 | 351 | W | F2P25? | Max battery discharge current | A | 15 | ❓ |
| 643 | 326 | W | F2P06? | Back to battery mode voltage | ×0.1 V | 530 (53.0V) | ❓ |
| 644 | 327 | W | F2P05? | Back to utility source voltage | ×0.1 V | 520 (52.0V) | ❓ |
| 645 | — | W | — | Reserved | — | 0 | ❓ |
| 646 | 329 | W | F2P07? | Main output cut-off voltage | ×0.1 V | 500 (50.0V) | ❓ |
| 647 | 341 | W | F2P07? | Main output cut-off SOC | % (20–50) | 4 | ❓ |
| 648 | 342 | W | F2P06? | Back to battery mode SOC | % (60–100) | 60 | ❓ |
| 649 | 343 | W | F2P08? | Second output cut-off SOC | % (3–30) | 0 | ❓ |
| 650 | — | W | — | Battery low cut-off SOC | % | 3 | ❓ |
| 651 | 344? | W | — | Unknown (PV grid-tie max power?) | — | 0 | ❓ |
| 652 | 334 | W | F2P18 | Battery equalization voltage | ×0.1 V | 564 (56.4V) | 🔍 |
| 653 | 335 | W | F2P19 | Battery equalized time | minutes (0–900) | 60 | 🔍 |
| 654 | 336 | W | F2P20 | Battery equalized timeout | minutes (0–900) | 120 | 🔍 |
| 655 | 337 | W | F2P21 | Equalization interval | days (1–90) | 30 | 🔍 |
| 656 | 313? | ERR | F2P17? | Battery equalization | 0=Off, 1=On (value 0 rejected) | 0 | ❓ |
| 657–676 | — | W | — | Reserved / unused | all 0 | 0 | — |

> F2 program numbers above `04` depend on whether the inverter is using voltage
> thresholds or SOC thresholds, and the firmware exposes several adjacent
> registers that still need LCD/write verification. Probable matches are marked
> with `?` instead of assigning incorrect manual IDs.

### 8.3 F0 System Settings (regs 677–690)

| Reg | Std | R/W | Prog | Name | Values / Unit | Live Value | Verified |
|-----|-----|-----|------|------|--------------|------------|----------|
| 677 | 302 | W | F0P01 | AC input voltage range | 0=APL, 1=UPS, 2=GNT | 1 (UPS) | 🔍 |
| 678 | 306 | W | F0P07 | LCD auto return | 0=Off, 1=1 min | 0 (Off) | 🔍 |
| 679 | 305 | W | F0P08 | LCD backlight | 0=Timed, 1=Always on | 1 (Always) | 🔍 |
| 680 | — | W | — | Unknown | — | 0 | ❓ |
| 681 | 307 | W | F0P02 | Power saving mode | 0=Off, 1=On | 0 (Off) | 🔍 |
| 682 | 308 | W | F0P04 | Overload auto restart | 0=No, 1=Yes | 0 (No) | 🔍 |
| 683 | 309 | W | F0P05 | Over-temperature auto restart | 0=No, 1=Yes | 0 (No) | 🔍 |
| 684 | 310 | W | F0P03 | Overload transfer to bypass | 0=Disable, 1=Enable | 0 (Disable) | 🔍 |
| 685 | — | R? | — | Unknown (read-only, does not persist writes) | — | 0 | ❓ |
| 686 | 312 | W? | — | Not the Modbus ID register on this firmware | — | 0 | ❌ |
| 687 | 314 | W | — | Warning mask (low word) | bitfield | 65535 (0xFFFF) | 🔍 |
| 688 | 315 | W | — | Warning mask (high word) | bitfield | 60927 (0xEDFF) | 🔍 |
| 689 | 316? | W | F0P16 | Dry contact mode | 0=md1 warning relay, 1=md2 neutral-ground bonding | 0 (md1) | 🔍 |
| 690 | 420 | W | — | Automatic mains output enable | 0=Disabled, 1=Enabled | 0 (Disabled) | ✅ Live FC10 write |

> Register 406 is a separate read-only boot-method mirror outside the 677–690 F0
> block. Observed values are `0=Can be powered on locally or remotely`,
> `1=Only local turn-on`, and `2=Only remote turn-on`. Direct writes to 406 via
> FC10 and FC06 were rejected, and no writable alias was found in the nearby
> 400–420 or 680–690 ranges.

### 8.4 F4 Factory Reset (reg 795)

| Reg | Std | R/W | Prog | Name | Values / Unit | Live Value | Verified |
|-----|-----|-----|------|------|--------------|------------|----------|
| 795 | 421 | W | F4P01 | Reset stored PV and output load energy data | Write 1 to trigger the reset | 0 | 🔍 |

> **CAUTION**: Writing value 1 to reg 795 is expected to reset all inverter
> settings to factory defaults. Register address derived from standard 421
> with +374 offset (consistent with other F0 settings). Confirmed writable
> in probe but NOT tested with value 1 (destructive operation).

---

## 9. Standard → Anenji Address Cross-Reference

For users familiar with the standard GM6200/SMG-II protocol:

| Standard Reg | Anenji Reg | Offset | Prog | Setting |
|-------------|-----------|--------|------|---------|
| 300 | 600 | +300 | F1P02 | AC output mode |
| 301 | 601 | +300 | F1P01 | Output source priority |
| 302 | 677 | +375 | F0P01 | AC input voltage range |
| 303 | 603 | +300 | F0P09 | Buzzer mode |
| 305 | 679 | +374 | F0P08 | LCD backlight |
| 306 | 678 | +372 | F0P07 | LCD auto return |
| 307 | 681 | +374 | F0P02 | Power saving mode |
| 308 | 682 | +374 | F0P04 | Overload auto restart |
| 309 | 683 | +374 | F0P05 | Over-temperature auto restart |
| 310 | 684 | +374 | F0P03 | Overload transfer to bypass |
| 312 | 865 | +553 | F0P10 | Modbus ID setting (actual live register on tested unit) |
| 313 | 656? | +343? | — | Eq enable (ERR) |
| 314–315 | 687–688 | +373 | — | Warning mask |
| 316? | 689 | +373? | F0P16 | Dry contact mode |
| 318 | 633? | +315? | — | Secondary output priority |
| 319 | 634? | +315? | — | Secondary charge priority |
| 320 | 606 | +286 | F1P03 | Output voltage |
| 321 | 607 | +286 | F1P04 | Output frequency |
| 322 | 630 | +308 | F2P01 | Battery type |
| 323 | 631 | +308 | — | Battery overvoltage protection point |
| 324 | 637 | +313 | F2P03 | Bulk charging voltage |
| 325 | 638 | +313 | F2P04 | Floating charging voltage |
| 326 | 643 | +317 | F2P06? | Back to battery mode voltage |
| 327 | 644 | +317 | F2P05? | Back to utility source voltage |
| 329 | 646 | +317 | F2P07? | Main output cut-off voltage |
| 330 | 639 | +309 | F2P16? | Bulk charging time / constant-to-float wait |
| 331 | 632 | +301 | F2P02 | Charge source priority |
| 332 | 640 | +308 | F2P09 | Maximum charging current |
| 333 | 641 | +308 | F2P10 | Maximum mains charging current |
| 334 | 652 | +318 | F2P18 | Battery equalization voltage |
| 335 | 653 | +318 | F2P19 | Battery equalized time |
| 336 | 654 | +318 | F2P20 | Battery equalized timeout |
| 337 | 655 | +318 | F2P21 | Equalization interval |
| 341 | 647 | +306 | F2P07? | Main output cut-off SOC |
| 342 | 648 | +306 | F2P06? | Back to battery mode SOC |
| 343 | 649 | +306 | F2P08? | Second output cut-off SOC |
| 351 | 642 | +291 | F2P25? | Max battery discharge current |
| 402 | 605 | +203 | — | Current output priority (R) |
| 403 | 636 | +233 | — | Current charge priority (R) |
| 420 | 690 | +270 | — | Automatic mains output enable |
| 421 | 795 | +374 | F4P01 | Reset stored PV and output load energy data |
| 434 | 696 | +262 | F3P01 | Time setting - Year |
| 435 | 697 | +262 | F3P02 | Time setting - Month |
| 436 | 698 | +262 | F3P03 | Time setting - Day |
| 437 | 699 | +262 | F3P04 | Time setting - Hour |
| 438 | 700 | +262 | F3P05 | Time setting - Minute |
| 439 | 701 | +262 | F3P06 | Time setting - Second |
| 626–633 | 754–761 | +128 | — | Firmware version (ASCII) |
| 643 | 691 | +48 | — | Rated power |
| 644 | 763 | +119 | — | Rated battery cells |

---

## 10. Output Priority Enum Values

Standard GM6200 values (1-based, **confirmed on this device via LCD**):

| Value | Code | Description |
|-------|------|-------------|
| 1 | SUB | PV → Utility → Battery (inverter priority) |
| 2 | SBU | PV → Battery → Utility |
| 3 | SUF | PV → Utility → Battery (PV can grid-tie) |
| 4 | ZEC | PV → Battery → Utility (self-consumption) |

> Value 0 exists in register but returns write error "mode-restricted" on reg 600
> (output mode), suggesting value 0 may not be valid for output priority either.

---

## 11. Charge Priority Enum Values

Standard GM6200 values (1-based, **confirmed on this device via LCD**):

| Value | Code | Description |
|-------|------|-------------|
| 1 | SOF | PV first |
| 2 | SNU | PV & Mains equal |
| 3 | OSO | PV only |
| 4 | SOR | PV priority, surplus to charge |

---

## 12. Bugs Found in Original Device Definition

1. **charge_priority pointed at reg 605** — reg 605 is READ-ONLY (it is the
   "current output priority" mirror).  The actual writable charge priority is
   **reg 632**.  This caused "modbus error" on every write attempt.

2. **output_priority enum values were 0-based (0=UTI, 1=SOL, 2=SBU, 3=SUB)**
   — correct values are 1-based: 1=SUB, 2=SBU, 3=SUF, 4=ZEC.  The user saw
   "UTI" and "SOL" modes that the inverter does not support.

3. **charge_priority enum values were wrong** — had 0=Utility, 1=PV, 2=PV+mains,
   3=PV only.  Correct: 1=SOF, 2=SNU, 3=OSO, 4=SOR.

4. **Many settings were missing** — buzzer mode, eq charge settings, overload
   restart, over-temp restart, bypass transfer, LCD auto return, off-grid SOC
   protection, remote switch, and current-priority read-only sensors.

---

## 13. Unknown Registers Needing Further Investigation

| Reg | Value | Writable | Notes |
|-----|-------|----------|-------|
| 602 | 0 | Yes | Between output priority and buzzer — possibly unused |
| 604 | 0 | Yes | Between buzzer and current output priority |
| 633 | 3 | Yes | Between charge priority and current charge priority — secondary output priority? |
| 634 | 0 | Yes | Secondary charge priority? |
| 635 | 0 | Yes | Unknown |
| 645 | 0 | Yes | Between mains low V and off-grid low V |
| 649 | 0 | Yes | Likely off-grid SOC protection (std 343) but value 0 seems low |
| 651 | 0 | Yes | Between battery cutoff SOC and eq charge V — PV grid-tie max power? |
| 656 | 0 | ERR | Eq enable? Write rejected even for current value |
| 680 | 0 | Yes | Between LCD backlight and energy saving |
| 685 | 0 | No | Read-only; does not persist writes (wrote 1, read back 0) |

---

## 14. BMS Communication Data (Data Source: `bms_data`, addr 971, count 16)

Discovered at registers 971–986. This block contains data from the lithium battery
management system (JK BMS in this case) communicated via the inverter's battery port.

| Reg | R/W | Name | Unit / Scale | Value | Verified |
|-----|-----|------|-------------|-------|----------|
| 971 | R | **BMS Charge Request Voltage** | ×0.1 V | 552 (55.2V = 3.45V×16) | **✅** |
| 972 | R | BMS Discharge Cutoff Voltage | ×0.1 V | 480 (48.0V = 3.0V×16) | 🔍 |
| 973 | R | BMS Charge Current Limit | ×0.1 A | 160 (16.0A) | 🔍 |
| 974 | R | BMS Discharge Current Limit | ×0.1 A | 110 (11.0A) | 🔍 |
| 975 | R | BMS Connected Flag? | — | 1 | ❓ |
| 976 | R | Unknown | — | 0 | ❓ |
| 977 | R | Unknown Flag? | — | 1 | ❓ |
| 978–979 | R | Unknown | — | 0 | ❓ |
| 980 | R | Battery Voltage (mirror) | ×0.1 V | 532 (53.2V) | 🔍 |
| 981 | R | Unknown | — | 0 | ❓ |
| 982 | R | Unknown | — | 65535 (0xFFFF) | ❓ |
| 983 | R | SOC (mirror) | % | 99 | 🔍 |
| 984 | R | Unknown | — | 0 | ❓ |
| 985 | R | Unknown | — | 9 | ❓ |
| 986 | R | Unknown Flag? | — | 1 | ❓ |
