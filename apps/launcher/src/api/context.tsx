import { createContext, useContext, type ReactNode } from "react";
import type { JouzuApi } from "./jouzu-api";

const ApiContext = createContext<JouzuApi | null>(null);

export function ApiProvider({ api, children }: { api: JouzuApi; children: ReactNode }) {
  return <ApiContext.Provider value={api}>{children}</ApiContext.Provider>;
}

export function useApi(): JouzuApi {
  const api = useContext(ApiContext);
  if (!api) throw new Error("JouzuApi is not available; wrap the app in ApiProvider.");
  return api;
}
