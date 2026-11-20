import {
  createContext,
  useState,
  type Dispatch,
  type SetStateAction,
  type ReactNode,
} from "react";

export const TaskSessionSelection = createContext<
  [string, Dispatch<SetStateAction<string>>] | null
>(null);

/** Both progress and conversation panes inspect the same explicitly selected run. */
export function TaskSessionSelectionProvider({
  children,
}: {
  children: ReactNode;
}) {
  const selection = useState("");
  return (
    <TaskSessionSelection.Provider value={selection}>
      {children}
    </TaskSessionSelection.Provider>
  );
}
