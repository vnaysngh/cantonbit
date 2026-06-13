import { redirect } from "next/navigation";

/** Legacy route — balances page replaces standalone receive. */
export default function ReceiveRedirectPage() {
  redirect("/balances?tab=transfers");
}
