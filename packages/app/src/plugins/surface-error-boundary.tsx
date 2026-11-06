import React, { Component, type ErrorInfo, type ReactNode } from "react";
import { Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";

const surfaceKeys = new WeakMap<object, number>();
let nextSurfaceKey = 0;
function surfaceKey(value: object): number {
  let key = surfaceKeys.get(value);
  if (key === undefined) {
    key = ++nextSurfaceKey;
    surfaceKeys.set(value, key);
  }
  return key;
}

/** Attribute ownership follows both the installation and actual contributed component. */
export function pluginSurfaceKey(lifetime: object, Surface: object): string {
  return `${surfaceKey(lifetime)}:${surfaceKey(Surface)}`;
}

interface SurfaceErrorBoundaryProps {
  children: ReactNode;
  installation: object;
  resetKey?: unknown;
  Surface: unknown;
  renderError?(error: string): ReactNode;
  onError?(): void;
}

interface SurfaceErrorBoundaryState {
  error: string | null;
}

export class SurfaceErrorBoundary extends Component<
  SurfaceErrorBoundaryProps,
  SurfaceErrorBoundaryState
> {
  state: SurfaceErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): SurfaceErrorBoundaryState {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.warn("[Plugins] Surface render failed", error, info.componentStack);
    this.props.onError?.();
  }

  componentDidUpdate(previous: SurfaceErrorBoundaryProps): void {
    if (
      this.state.error &&
      (previous.installation !== this.props.installation ||
        previous.resetKey !== this.props.resetKey ||
        previous.Surface !== this.props.Surface)
    ) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      if (this.props.renderError) return this.props.renderError(this.state.error);
      return <Text style={styles.errorText}>Plugin failed: {this.state.error}</Text>;
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create((theme) => ({
  errorText: {
    color: theme.colors.statusDanger,
    padding: theme.spacing[4],
  },
}));
