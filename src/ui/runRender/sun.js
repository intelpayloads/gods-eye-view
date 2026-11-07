/**
 * The sun's altitude at a place and time (GEN-369). The renderer refuses a
 * shot whose observer has the sun at or below the horizon at `window.start`,
 * so the render panel says so before sending one.
 *
 * This is the renderer's own formula (droneimages
 * `orchestrator/src/processing/prompt_pass/solar.rs`, `solar_position`), line
 * for line: the panel and the renderer agree at dusk because they compute the
 * same number, not two good ones. Pure.
 */
const rem = (a, b) => ((a % b) + b) % b;
const rad = (deg) => (deg * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

/** Degrees above the horizon of the sun at `{lon, lat}` and ISO `validAt`; null if unreadable. */
export function sunAltitudeDeg({ lon, lat }, validAt) {
  const ms = Date.parse(validAt);
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || !Number.isFinite(ms)) return null;
  if (lat < -90 || lat > 90) return null;
  const unixSeconds = ms / 1000;
  const n = 2_440_587.5 + unixSeconds / 86_400 - 2_451_545.0;
  const l = rem(280.46 + 0.9856474 * n, 360);
  const g = rad(rem(357.528 + 0.9856003 * n, 360));
  const lambda = rad(l + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g));
  const epsilon = rad(23.439 - 0.0000004 * n);
  const dec = Math.asin(Math.sin(epsilon) * Math.sin(lambda));
  const alpha = rem(deg(Math.atan2(Math.cos(epsilon) * Math.sin(lambda), Math.cos(lambda))), 360);
  const hUt = rem(unixSeconds, 86_400) / 3600;
  const d0 = n - hUt / 24;
  const gmst = rem(6.697374558 + 0.06570982441908 * d0 + 1.00273790935 * hUt, 24);
  const lst = rem(gmst * 15 + lon, 360);
  const hour = rad(rem(lst - alpha + 540, 360) - 180);
  const phi = rad(lat);
  return deg(Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(hour)));
}
