import { MERGE_FIELDS, listTemplates } from "@rcm/core";
import { TemplateEditor } from "@/components/TemplateEditor";

export const dynamic = "force-dynamic";

export default async function Templates() {
  const templates = await listTemplates();
  return (
    <>
      <div className="head"><div><h1>Email templates</h1><div className="muted">Write it once, personalise with merge fields. Use templates in a <a href="/sequences">sequence</a> step instead of AI drafting; two templates in one step make an A/B test. The legally required footer is added automatically.</div></div></div>
      <div className="grid g2">
        <TemplateEditor fields={MERGE_FIELDS} />
        <div className="grid" style={{ alignContent: "start" }}>
          {templates.length === 0 && <div className="card muted">No templates yet.</div>}
          {templates.map((t) => <TemplateEditor key={t.id} template={{ id: t.id, name: t.name, subject: t.subject, body: t.body, active: t.active }} fields={MERGE_FIELDS} />)}
        </div>
      </div>
    </>
  );
}
