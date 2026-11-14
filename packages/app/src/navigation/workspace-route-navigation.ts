import type {
  NavigationAction,
  NavigationContainerRef,
  NavigationContainerRefWithCurrent,
} from "expo-router/react-navigation";
import { router, type Href } from "expo-router";
import {
  decodeWorkspaceIdFromPathSegment,
  encodeWorkspaceIdForPathSegment,
  getHostWorkspaceOpenParamFromPathname,
  parseHostWorkspaceRouteFromPathname,
} from "@/utils/host-routes";
import type { ActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";

const ROOT_HOST_ROUTE_NAME = "h/[serverId]";
const HOST_WORKSPACE_ROUTE_NAME = "workspace/[workspaceId]/index";

interface NavigateToHostWorkspaceRouteDeps {
  dismissTo(route: string): void;
}

const defaultNavigateToHostWorkspaceRouteDeps: NavigateToHostWorkspaceRouteDeps = {
  dismissTo: (route) => router.dismissTo(route as Href),
};

let rootNavigationRef: NavigationContainerRefWithCurrent<ReactNavigation.RootParamList> | null =
  null;
let pendingIntent: { route: string; deps: NavigateToHostWorkspaceRouteDeps } | null = null;

export function registerWorkspaceRouteNavigationRef(
  ref: NavigationContainerRefWithCurrent<ReactNavigation.RootParamList>,
): () => void {
  rootNavigationRef = ref;
  const unsubscribe = ref.addListener("ready", flushPendingIntent);
  flushPendingIntent();
  return () => {
    unsubscribe();
    if (rootNavigationRef === ref) {
      rootNavigationRef = null;
    }
  };
}

interface MountedRouteStack {
  key: string;
  focusedRouteName: string | null;
}

function findStackWithMountedRouteName(
  state: unknown,
  routeName: string,
): MountedRouteStack | null {
  if (!state || typeof state !== "object") {
    return null;
  }

  const candidate = state as {
    index?: unknown;
    key?: unknown;
    routes?: unknown;
  };

  if (!Array.isArray(candidate.routes)) {
    return null;
  }

  if (
    typeof candidate.key === "string" &&
    candidate.routes.some(
      (route) =>
        !!route && typeof route === "object" && (route as { name?: unknown }).name === routeName,
    )
  ) {
    const focusedIndex =
      typeof candidate.index === "number" &&
      Number.isInteger(candidate.index) &&
      candidate.index >= 0 &&
      candidate.index < candidate.routes.length
        ? candidate.index
        : candidate.routes.length - 1;
    const focusedRoute = candidate.routes[focusedIndex];
    const focusedRouteName =
      focusedRoute && typeof focusedRoute === "object"
        ? (focusedRoute as { name?: unknown }).name
        : null;
    return {
      key: candidate.key,
      focusedRouteName: typeof focusedRouteName === "string" ? focusedRouteName : null,
    };
  }

  for (const route of candidate.routes) {
    if (!route || typeof route !== "object") {
      continue;
    }
    const childStack = findStackWithMountedRouteName(
      (route as { state?: unknown }).state,
      routeName,
    );
    if (childStack) {
      return childStack;
    }
  }

  return null;
}

function dispatchHostWorkspacePopTo(
  route: string,
  navigation: NavigationContainerRef<ReactNavigation.RootParamList>,
): boolean {
  const selection = parseHostWorkspaceRouteFromPathname(route);
  if (!selection) {
    return false;
  }

  const rootState = navigation.getRootState();
  const hostStack = findStackWithMountedRouteName(rootState, ROOT_HOST_ROUTE_NAME);
  if (!hostStack || hostStack.focusedRouteName === ROOT_HOST_ROUTE_NAME) {
    return false;
  }
  const open = getHostWorkspaceOpenParamFromPathname(route);

  const action: NavigationAction = {
    type: "POP_TO",
    target: hostStack.key,
    payload: {
      name: ROOT_HOST_ROUTE_NAME,
      params: {
        serverId: selection.serverId,
        screen: HOST_WORKSPACE_ROUTE_NAME,
        params: {
          serverId: selection.serverId,
          workspaceId: encodeWorkspaceIdForPathSegment(selection.workspaceId),
          ...(open ? { open } : {}),
        },
        // React Navigation consumes this nested hint when resolving the host child screen.
        // The browser-route canonicalizer strips the resulting ?pop=true URL artifact.
        // Removing it lets repeated /new -> workspace hops append hidden deck entries.
        pop: true,
      },
    },
  };
  navigation.dispatch(action);
  return true;
}

interface FocusedNavigationRoute {
  name: string;
  params?: Record<string, unknown>;
}

function findFocusedNavigationRoute(
  state: unknown,
  inheritedParams: Record<string, unknown> = {},
): FocusedNavigationRoute | null {
  if (!state || typeof state !== "object") return null;
  const candidate = state as { index?: unknown; routes?: unknown };
  if (!Array.isArray(candidate.routes) || candidate.routes.length === 0) return null;
  const focusedIndex =
    typeof candidate.index === "number" &&
    Number.isInteger(candidate.index) &&
    candidate.index >= 0 &&
    candidate.index < candidate.routes.length
      ? candidate.index
      : candidate.routes.length - 1;
  const route = candidate.routes[focusedIndex];
  if (!route || typeof route !== "object") return null;
  const routeParams = (route as { params?: unknown }).params;
  const params = {
    ...inheritedParams,
    ...(routeParams && typeof routeParams === "object"
      ? (routeParams as Record<string, unknown>)
      : {}),
  };
  const nested = findFocusedNavigationRoute((route as { state?: unknown }).state, params);
  if (nested) return nested;
  const name = (route as { name?: unknown }).name;
  if (typeof name !== "string") return null;
  return { name, params };
}

function readStringParam(params: Record<string, unknown> | undefined, key: string): string | null {
  const value = params?.[key];
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * The workspace selected by the focused navigation leaf at call time. Unlike a captured
 * `selected` prop, this survives an archive-induced row unmount and still returns `null` when the
 * user moves to Settings or another workspace while an archive is pending.
 */
export function getFocusedWorkspaceSelection(): ActiveWorkspaceSelection | null {
  const state = rootNavigationRef?.current?.getRootState();
  const focused = findFocusedNavigationRoute(state);
  if (focused?.name !== HOST_WORKSPACE_ROUTE_NAME) return null;
  const serverId = readStringParam(focused.params, "serverId");
  const encodedWorkspaceId = readStringParam(focused.params, "workspaceId");
  if (!serverId || !encodedWorkspaceId) return null;
  const workspaceId = decodeWorkspaceIdFromPathSegment(encodedWorkspaceId);
  if (!workspaceId) return null;
  return {
    serverId,
    workspaceId,
  };
}

export function navigateToHostWorkspaceRoute(
  route: string,
  deps: NavigateToHostWorkspaceRouteDeps = defaultNavigateToHostWorkspaceRouteDeps,
): void {
  pendingIntent = { route, deps };
  flushPendingIntent();
}

function flushPendingIntent(): void {
  const navigation = rootNavigationRef?.current;
  if (!pendingIntent || !navigation?.isReady()) return;

  const { route, deps } = pendingIntent;
  pendingIntent = null;
  if (!dispatchHostWorkspacePopTo(route, navigation)) deps.dismissTo(route);
}
