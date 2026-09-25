// One colour per leg of a journey, shared by the card's leg bar and the map polylines so a leg is
// recognisable in both places. Chosen to stay distinct on light and dark basemaps.
export const LEG_COLORS = ["#4f46e5", "#0d9488", "#ea580c", "#db2777", "#0284c7", "#65a30d"];

export function legColor(i: number): string {
  return LEG_COLORS[i % LEG_COLORS.length];
}
