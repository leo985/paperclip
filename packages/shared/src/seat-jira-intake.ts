/** A seat with this capability delegates repository/path/worktree management to Harness. */
export const HARNESS_REPOSITORY_MANAGEMENT_CAPABILITY = "harness-repository-management-v1";

/** Version 4 never carries a platform workspace or local source directory. */
export interface HarnessManagedJiraIntake {
  version: 4;
  status_source: "seat_rule";
  seat_id: string;
  jira_key: string;
  project_id: string;
}
