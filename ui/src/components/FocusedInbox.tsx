import { Navigate, useLocation } from "@/lib/router";
import { legacyInboxTarget } from "@/lib/workbench";

/** Old bookmarks retain company/project context and land in the unified workbench. */
export function FocusedInbox() {
  const location = useLocation();
  return <Navigate to={legacyInboxTarget(location.pathname, location.search, location.hash)} replace />;
}
