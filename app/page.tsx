import { redirect } from "next/navigation";

/**
 * Swap is the only surfaced product right now, so the app lands directly on it.
 * The former dashboard still exists at /dashboard (just not linked in the nav);
 * re-point this or restore the header nav when the other flows are ready.
 */
export default function HomePage() {
  redirect("/swap");
}
