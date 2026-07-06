export function maskValue(val: string): string {
  const v = val.trim()
  return v.length > 8 ? `${v.slice(0, 4)}••••••••${v.slice(-4)}` : '••••••••'
}
