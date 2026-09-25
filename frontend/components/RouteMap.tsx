"use client";

// Leaflet map of the journeys. Loaded only in the browser (see MapPanel), draws from the static
// station-coords.json, so selecting or hovering a journey never calls the API.
import "leaflet/dist/leaflet.css";
import { Fragment, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { CircleMarker, MapContainer, Pane, Polyline, TileLayer, Tooltip, useMap, ZoomControl } from "react-leaflet";
import { boundsOf, INDIA_CENTER, journeyPaths, loadCoords, type Coords, type LatLon } from "@/lib/geo";
import { hhmm, stationLabel } from "@/lib/format";
import { legColor } from "@/lib/palette";
import type { Journey, StationHit } from "@/lib/types";

export interface RouteMapProps {
  journeys: Journey[];
  selectedId: string | null;
  hoverId: string | null;
  onSelect: (id: string) => void;
  endpoints: { from: StationHit | null; to: StationHit | null };
  fitAllSignal: number;
}

const darkQuery = "(prefers-color-scheme: dark)";
function useDark(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(darkQuery);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => window.matchMedia(darkQuery).matches,
    () => false,
  );
}

// Esri's grey canvas: keyless raster tiles with a light and a dark variant, plus a separate label layer
// drawn above the routes' casing. (CARTO basemaps now require an API key.)
const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas";
const TILE = (dark: boolean, layer: "Base" | "Reference") => `${ESRI}/World_${dark ? "Dark" : "Light"}_Gray_${layer}/MapServer/tile/{z}/{y}/{x}`;
const ATTRIBUTION =
  'Tiles &copy; <a href="https://www.esri.com">Esri</a>, HERE, Garmin, &copy; OpenStreetMap contributors · stations: <a href="https://github.com/datameet/railways">datameet</a>';

/**
 * Fits the view whenever `bounds` changes identity. Leaflet cannot see its box resize (the layout
 * changes once results arrive, and the map is hidden on small screens), so it re-measures and
 * re-fits on every resize too.
 */
function ViewController({ bounds, topPad }: { bounds: [LatLon, LatLon] | null; topPad: number }) {
  const map = useMap();
  const latest = useRef(bounds);
  latest.current = bounds;
  const pad = useRef(topPad);
  pad.current = topPad;
  const fit = (b: [LatLon, LatLon], animate: boolean) =>
    map.fitBounds(b, { paddingTopLeft: [40, pad.current], paddingBottomRight: [40, 56], maxZoom: 10, animate });
  useEffect(() => {
    if (bounds) fit(bounds, true);
  }, [map, bounds]);
  useEffect(() => {
    const el = map.getContainer();
    let w = el.clientWidth;
    let h = el.clientHeight;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === w && el.clientHeight === h) return;
      w = el.clientWidth;
      h = el.clientHeight;
      map.invalidateSize({ pan: false });
      if (latest.current && w > 0 && h > 0) fit(latest.current, false);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [map]);
  return null;
}

export default function RouteMap({ journeys, selectedId, hoverId, onSelect, endpoints, fitAllSignal }: RouteMapProps) {
  const dark = useDark();
  const [coords, setCoords] = useState<Coords | null>(null);
  useEffect(() => {
    let live = true;
    loadCoords().then((c) => live && setCoords(c));
    return () => {
      live = false;
    };
  }, []);

  const paths = useMemo(() => {
    const m = new Map<string, LatLon[][]>();
    if (coords) for (const j of journeys) m.set(j.id, journeyPaths(j, coords));
    return m;
  }, [journeys, coords]);

  const selected = journeys.find((j) => j.id === selectedId) ?? null;
  const pin = (s: StationHit | null) => (s && coords?.[s.code] ? { s, p: coords[s.code] } : null);
  const from = pin(endpoints.from);
  const to = pin(endpoints.to);

  // What to frame: the selected journey, else all journeys (after "fit all"), else the chosen endpoints.
  const [fitAll, setFitAll] = useState(false);
  useEffect(() => setFitAll(fitAllSignal > 0), [fitAllSignal]);
  useEffect(() => setFitAll(false), [selectedId]);
  const bounds = useMemo(() => {
    if (!coords) return null;
    if (selected && !fitAll) return boundsOf((paths.get(selected.id) ?? []).flat());
    if (journeys.length) return boundsOf([...paths.values()].flat(2));
    return boundsOf([from?.p, to?.p].filter((p): p is LatLon => !!p));
  }, [coords, selected, fitAll, journeys, paths, from?.p, to?.p]);

  const others = journeys.filter((j) => j.id !== selectedId);
  const muted = dark ? "#64748b" : "#94a3b8";

  return (
    <MapContainer center={INDIA_CENTER} zoom={5} minZoom={4} maxZoom={13} zoomSnap={0.25} className="h-full w-full" zoomControl={false}>
      <ZoomControl position="bottomright" />
      <TileLayer key={dark ? "d" : "l"} url={TILE(dark, "Base")} attribution={ATTRIBUTION} maxNativeZoom={16} />
      <Pane name="labels" style={{ zIndex: 450, pointerEvents: "none" }}>
        <TileLayer key={dark ? "dr" : "lr"} url={TILE(dark, "Reference")} maxNativeZoom={16} />
      </Pane>
      <ViewController bounds={bounds} topPad={selected && !fitAll ? 56 + 20 * selected.segments.length : 56} />

      {/* the other journeys, faint; hover in the list lifts one */}
      {others.map((j) => {
        const hot = j.id === hoverId;
        return (paths.get(j.id) ?? []).map((line, i) => (
          <Polyline
            key={`${j.id}-${i}-${hot}`}
            positions={line}
            pathOptions={{ color: hot ? "#6366f1" : muted, weight: hot ? 4 : 2.5, opacity: hot ? 0.95 : 0.35, dashArray: hot ? undefined : "4 6" }}
            eventHandlers={{ click: () => onSelect(j.id) }}
          />
        ));
      })}

      {/* the selected journey: a light casing under each coloured leg */}
      {selected &&
        (paths.get(selected.id) ?? []).map((line, i) => (
          <Fragment key={`${selected.id}-${i}`}>
            <Polyline positions={line} pathOptions={{ color: dark ? "#0f172a" : "#ffffff", weight: 8, opacity: 0.9 }} interactive={false} />
            <Polyline positions={line} pathOptions={{ color: legColor(i), weight: 4.5, opacity: 1, lineJoin: "round" }}>
              <Tooltip sticky className="stop-tip">
                {selected.segments[i].train_number} {selected.segments[i].train_name}
              </Tooltip>
            </Polyline>
          </Fragment>
        ))}

      {/* intermediate stops of the selected journey */}
      {selected &&
        coords &&
        selected.segments.flatMap((seg, i) =>
          seg.stops.slice(1, -1).map((s, k) => {
            const p = s.code ? coords[s.code] : undefined;
            if (!p) return null;
            return (
              <CircleMarker
                key={`${i}-${k}`}
                center={p}
                radius={3}
                pathOptions={{ color: legColor(i), weight: 1.5, fillColor: dark ? "#0f172a" : "#ffffff", fillOpacity: 1 }}
              >
                <Tooltip className="stop-tip" direction="top" offset={[0, -4]}>
                  <div className="font-semibold">{stationLabel(s)}</div>
                  <div className="tabular opacity-80">
                    {s.arrival_datetime ? hhmm(s.arrival_datetime) : "--:--"} – {s.departure_datetime ? hhmm(s.departure_datetime) : "--:--"}
                    {!s.boardable && " · pass-through"}
                  </div>
                </Tooltip>
              </CircleMarker>
            );
          }),
        )}

      {/* transfer stations */}
      {selected &&
        coords &&
        selected.transfers.map((t, i) => {
          const p = t.station.code ? coords[t.station.code] : undefined;
          if (!p) return null;
          return (
            <CircleMarker key={`t${i}`} center={p} radius={7} pathOptions={{ color: legColor(i + 1), weight: 3, fillColor: "#ffffff", fillOpacity: 1 }}>
              {/* Leaflet binds one tooltip per layer, so the label carries the wait too */}
              <Tooltip permanent direction="right" offset={[8, 0]} className="code-tip">
                {t.station.code} <span className="font-sans font-medium opacity-70">{t.wait_minutes}m</span>
              </Tooltip>
            </CircleMarker>
          );
        })}

      {/* endpoints: from the selected journey, or the stations picked in the form before a search */}
      {[
        { key: "src", p: selected ? coords?.[selected.source.code ?? ""] : from?.p, code: selected ? selected.source.code : from?.s.code, fill: "#059669" },
        { key: "dst", p: selected ? coords?.[selected.destination.code ?? ""] : to?.p, code: selected ? selected.destination.code : to?.s.code, fill: "#e11d48" },
      ].map((e) =>
        e.p ? (
          <CircleMarker key={`${e.key}-${e.code}`} center={e.p} radius={9} pathOptions={{ color: "#ffffff", weight: 3, fillColor: e.fill, fillOpacity: 1 }}>
            <Tooltip permanent direction="top" offset={[0, -10]} className="code-tip">
              {e.code}
            </Tooltip>
          </CircleMarker>
        ) : null,
      )}
      {!selected && from && to && journeys.length === 0 && (
        <Polyline positions={[from.p, to.p]} pathOptions={{ color: "#6366f1", weight: 2, dashArray: "6 8", opacity: 0.7 }} interactive={false} />
      )}
    </MapContainer>
  );
}
