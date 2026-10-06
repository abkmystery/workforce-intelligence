import { notFound, redirect } from "next/navigation";
import { getActor } from "@/lib/auth";
import { navItemFor } from "@/components/navigation";
import { WorkspaceShell } from "@/components/workspace-shell";
import { ModuleView } from "@/components/module-view";

export const dynamic = "force-dynamic";

export default async function WorkspacePage({ params }: { params: Promise<{ module: string }> }) {
  const { module } = await params;
  if (!navItemFor(module)) notFound();
  let actor;
  try {
    actor = await getActor();
  } catch (error) {
    if (typeof error === "object" && error !== null && "status" in error && error.status === 401) redirect("/login");
    throw error;
  }
  return <WorkspaceShell actorLabel={actor.userId}><ModuleView module={module} /></WorkspaceShell>;
}
