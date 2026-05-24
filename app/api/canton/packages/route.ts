import { NextResponse } from "next/server";

import { getLedgerJwt } from "@/lib/auth";
import { NETWORK } from "@/lib/constants";

export const dynamic = "force-dynamic";

/**
 * GET /api/canton/packages
 *
 * Lists every DAR package installed on the participant. Optional `?filter=foo`
 * substring-matches package names so you can verify specific DARs are uploaded:
 *
 *   curl 'http://localhost:3000/api/canton/packages?filter=splice-api-token'
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const filter = url.searchParams.get("filter")?.toLowerCase() ?? null;

  try {
    const jwt = await getLedgerJwt();
    const res = await fetch(`${NETWORK.ledgerHost}/v2/packages`, {
      headers: { authorization: `Bearer ${jwt}` },
      cache: "no-store",
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "<no body>");
      return NextResponse.json(
        { error: `GET /v2/packages failed (${res.status}): ${text}` },
        { status: 500 },
      );
    }

    // This Canton version returns { packageIds: string[] } — opaque hashes,
    // no names. The /v2/packages/<id>/reference endpoint that would give us
    // names returns 404 here. /v2/packages/<id> returns the raw binary DAR.
    //
    // So the practical answer: we can confirm "N packages installed" but
    // can't filter by name. The real test of whether cBTC DARs are present
    // is whether the mint or burn flow works — they reference templates by
    // package-name prefix (#cbtc:...) and Canton resolves those at submit
    // time. If the templates aren't found, the submit returns a clear
    // "package not vetted" error.
    const data = (await res.json()) as { packageIds?: string[] };
    const ids = data.packageIds ?? [];
    return NextResponse.json({
      count: ids.length,
      packageIds: ids,
      note:
        filter !== null
          ? "Filter ignored: this Canton version doesn't expose package names via the JSON API. Try the mint flow to verify DARs."
          : undefined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
