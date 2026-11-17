export type DropPoint = {
  label: string;
  address: string;
  lat?: number;
  lng?: number;
};

/** Builds a Google Maps multi-stop directions URL for SELF delivery drivers. */
export function buildMultiStopMapsUrl(points: DropPoint[]): string {
  if (points.length === 0) return "";
  const encoded = points.map((p) => encodeURIComponent(p.address));
  if (encoded.length === 1) {
    return `https://www.google.com/maps/dir/?api=1&destination=${encoded[0]}`;
  }
  const origin = encoded[0];
  const destination = encoded[encoded.length - 1];
  const waypoints = encoded.slice(1, -1).join("%7C");
  const wp = waypoints ? `&waypoints=${waypoints}` : "";
  return `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${destination}${wp}`;
}
