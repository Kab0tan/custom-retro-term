/**
 * Which Linux temperature sensor is the CPU. /sys/class/thermal lists zones in no useful order and the first one is
 * often `acpitz`, a board sensor that can read 30 °C below the package, so readings are ranked: the CPU's own sensors
 * first, `acpitz` as a last resort, anything else (Wi-Fi card, chipset…) after it.
 */
export interface ThermalReading {
  /** Thermal zone type (`x86_pkg_temp`, `acpitz`…) or, for hwmon, `<chip> <label>` such as `k10temp Tctl`. */
  name: string
  celsius: number
  /** `zone`: /sys/class/thermal/thermal_zone<index>. `hwmon`: a CPU chip in /sys/class/hwmon/hwmon<index>. */
  source: 'zone' | 'hwmon'
  index: number
}

export interface TemperatureZone {
  name: string
  celsius: number
  /** The reading comes from a CPU sensor, not a board, chipset or device one. */
  cpu: boolean
}

/** hwmon chips that measure the CPU: Intel, AMD, and AMD's out-of-tree alternative driver. */
export const CPU_HWMON_CHIPS = ['coretemp', 'k10temp', 'zenpower']

/** Which of a CPU chip's inputs to show: the package (Intel) or die (AMD), else Tctl, else whatever comes first. */
export function hwmonLabelRank(label: string): number {
  if (/^package id/i.test(label) || label === 'Tdie') return 0
  if (label === 'Tctl') return 1
  return 2
}

const ACPI_RANK = 4

function rank(r: ThermalReading): number {
  if (r.source === 'hwmon') return 1
  const type = r.name.toLowerCase()
  if (type === 'x86_pkg_temp') return 0
  if (type.startsWith('tcpu')) return 2 // Intel DPTF processor participant
  if (/^(cpu\d*|soc)[-_]thermal$/.test(type)) return 3 // ARM device-tree zones (Raspberry Pi, Rockchip…)
  if (type === 'acpitz') return ACPI_RANK
  return ACPI_RANK + 1
}

/** Best reading first; ties keep the sensor's number order (thermal_zone2 before thermal_zone10). */
export function rankThermal(readings: ThermalReading[]): TemperatureZone[] {
  return readings
    .map((r) => ({ r, rank: rank(r) }))
    .sort((a, b) => a.rank - b.rank || a.r.index - b.r.index)
    .map(({ r, rank }) => ({ name: r.name, celsius: r.celsius, cpu: rank < ACPI_RANK }))
}
