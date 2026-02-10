export type RouteId = "analyze" | "result";

export function getRouteFromHash(): RouteId {
    const h = (window.location.hash || "").replace("#", "").trim();
    if (h === "result") return "result";
    return "analyze";
}

export function setRouteHash(route: RouteId) {
    const next = route === "result" ? "#result" : "#analyze";
    if (window.location.hash !== next) window.location.hash = next;
}
