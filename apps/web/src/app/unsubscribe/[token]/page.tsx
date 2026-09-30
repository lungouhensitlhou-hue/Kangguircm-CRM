import { UnsubscribeForm } from "@/components/UnsubscribeForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "Unsubscribe", robots: { index: false } };

export default async function Unsubscribe({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <div className="center">
      <div className="card narrow">
        <h1>Unsubscribe</h1>
        <p className="muted">Click below to stop receiving emails from us. This takes effect immediately.</p>
        <UnsubscribeForm token={token} />
      </div>
    </div>
  );
}
