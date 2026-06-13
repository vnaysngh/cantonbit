import { redirect } from "next/navigation";

/** Legacy route — balances page replaces standalone send. */
export default function SendRedirectPage() {
  redirect("/balances?tab=transfers");
}
