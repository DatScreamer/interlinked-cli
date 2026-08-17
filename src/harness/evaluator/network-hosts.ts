// ===========================================
// Non-routable host detection (loopback + private ranges)
// ===========================================
// Several nudges/guards only make sense for PUBLIC network egress: the
// markdown-first hint (Cloudflare Markdown for Agents is a public-edge feature)
// and the curl-to-MCP heuristic both fire on http(s) URLs. Restricting the
// exemption to `localhost|127.0.0.1` was too narrow — a two-box setup curls its
// peer over a tailnet CGNAT address (100.64.0.0/10) and a LAN service over
// 10/192.168/172.16-31, none of which reach any public edge. Firing there is
// pure noise (measured 2026-08-11: ~6 markdown-first nudges on loopback +
// tailnet health polls). One predicate, reused, so the ranges never drift.

/** IPv4 octet groups → private/loopback range membership. */
function isPrivateIpv4(host: string): boolean {
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
	if (!m) return false;
	const a = Number(m[1]);
	const b = Number(m[2]);
	if (a > 255 || b > 255) return false;
	if (a === 127) return true; // loopback 127.0.0.0/8
	if (a === 10) return true; // private 10.0.0.0/8
	if (a === 192 && b === 168) return true; // private 192.168.0.0/16
	if (a === 172 && b >= 16 && b <= 31) return true; // private 172.16.0.0/12
	if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT / tailnet 100.64.0.0/10
	if (a === 169 && b === 254) return true; // link-local 169.254.0.0/16
	return false;
}

/** A hostname (not IP) that never leaves the machine/LAN. */
function isLocalHostname(host: string): boolean {
	const h = host.toLowerCase();
	return (
		h === "localhost" || h === "::1" || h === "[::1]" || h.endsWith(".local") || h === "0.0.0.0"
	);
}

/** True when `host` is loopback, link-local, or an RFC-1918 / CGNAT private
 *  address — i.e. egress that never reaches a public edge. */
export function isNonRoutableHost(host: string): boolean {
	const bare = host.replace(/^\[/, "").replace(/\]$/, "");
	return isLocalHostname(bare) || isPrivateIpv4(bare);
}

/** True when `cmd` contains at least one http(s) URL whose host is PUBLIC.
 *  Used to gate public-egress-only nudges: a command that only touches
 *  loopback/private hosts returns false. */
export function hasPublicHttpUrl(cmd: string): boolean {
	const re = /https?:\/\/([^/\s"'|)]+)/gi;
	for (let m = re.exec(cmd); m !== null; m = re.exec(cmd)) {
		const hostPort = m[1] ?? "";
		const host = hostPort.replace(/:\d+$/, "");
		if (!isNonRoutableHost(host)) return true;
	}
	return false;
}
