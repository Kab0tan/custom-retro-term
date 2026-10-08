import { describe, expect, it } from 'vitest'
import { hwmonLabelRank, rankThermal, type ThermalReading } from '@shared/thermal'

const zone = (index: number, name: string, celsius: number): ThermalReading => ({ name, celsius, source: 'zone', index })
const hwmon = (index: number, name: string, celsius: number): ThermalReading => ({ name, celsius, source: 'hwmon', index })

describe('rankThermal', () => {
  it('puts the CPU package ahead of acpitz, whatever the zone order', () => {
    const r = rankThermal([zone(0, 'acpitz', 32), zone(1, 'INT3400 Thermal', 20), zone(10, 'x86_pkg_temp', 69), zone(2, 'TCPU', 68)])
    expect(r.map((z) => z.name)).toEqual(['x86_pkg_temp', 'TCPU', 'acpitz', 'INT3400 Thermal'])
    expect(r[0]).toEqual({ name: 'x86_pkg_temp', celsius: 69, cpu: true })
    expect(r.find((z) => z.name === 'acpitz')?.cpu).toBe(false)
  })

  it('prefers hwmon CPU chips to TCPU and ARM zones', () => {
    const r = rankThermal([zone(0, 'cpu-thermal', 50), zone(1, 'TCPU', 60), hwmon(3, 'k10temp Tctl', 55)])
    expect(r.map((z) => z.name)).toEqual(['k10temp Tctl', 'TCPU', 'cpu-thermal'])
    expect(r.every((z) => z.cpu)).toBe(true)
  })

  it('recognises ARM CPU zones', () => {
    for (const name of ['cpu_thermal', 'cpu-thermal', 'cpu0-thermal', 'soc_thermal', 'soc-thermal']) {
      expect(rankThermal([zone(0, 'acpitz', 30), zone(1, name, 45)])[0]).toEqual({ name, celsius: 45, cpu: true })
    }
  })

  it('orders zones by number, not by name (thermal_zone2 before thermal_zone10)', () => {
    const r = rankThermal([zone(10, 'acpitz', 40), zone(2, 'acpitz', 30)])
    expect(r.map((z) => z.celsius)).toEqual([30, 40])
  })

  it('falls back to acpitz, then other sensors, and never calls them the CPU', () => {
    const r = rankThermal([zone(0, 'iwlwifi_1', 45), zone(1, 'acpitz', 30)])
    expect(r.map((z) => z.name)).toEqual(['acpitz', 'iwlwifi_1'])
    expect(r.some((z) => z.cpu)).toBe(false)
    expect(rankThermal([])).toEqual([])
  })
})

describe('hwmonLabelRank', () => {
  it('prefers the package (Intel) or die (AMD), then Tctl, then anything', () => {
    expect(hwmonLabelRank('Package id 0')).toBe(0)
    expect(hwmonLabelRank('Tdie')).toBe(0)
    expect(hwmonLabelRank('Tctl')).toBe(1)
    expect(hwmonLabelRank('Core 0')).toBe(2)
    expect(hwmonLabelRank('Tccd1')).toBe(2)
  })
})
