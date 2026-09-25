import { createContext } from 'react';

export interface Crumb {
  label: string;
  to?: string;
}

export interface TopBarState {
  crumbs: Crumb[];
  /** shown as an "as of" pill when relevant */
  asOf?: string | null;
}

export interface ShellApi {
  topBar: TopBarState;
  setTopBar: (state: TopBarState) => void;
}

export const ShellContext = createContext<ShellApi | null>(null);

/** id of the below-`lg` navigation drawer (the top bar's menu button controls it). */
export const MOBILE_NAV_ID = 'mobile-nav';
