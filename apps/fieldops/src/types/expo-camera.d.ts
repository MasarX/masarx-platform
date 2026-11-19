declare module "expo-camera" {
  export type BarcodeScanningResult = {
    type: string;
    data: string;
    bounds?: unknown;
    cornerPoints?: unknown[];
    [key: string]: unknown;
  };

  export type CameraCapturedPicture = {
    uri: string;
    width?: number;
    height?: number;
    base64?: string;
    exif?: unknown;
    [key: string]: unknown;
  };

  export type CameraPermissionResponse = {
    granted: boolean;
    canAskAgain: boolean;
    status: string;
    expires?: string | number | "never";
    [key: string]: unknown;
  };

  export type CameraViewProps = import("react-native").ViewProps & {
    barcodeScannerSettings?: {
      barcodeTypes?: string[];
    };
    facing?: "back" | "front";
    mode?: "picture" | "video";
    onBarcodeScanned?: (result: BarcodeScanningResult) => void;
    children?: import("react").ReactNode;
  };

  export class CameraView {
    constructor(props: CameraViewProps);
    props: CameraViewProps;
    state: Readonly<Record<string, unknown>>;
    context: unknown;
    setState(state: unknown, callback?: () => void): void;
    forceUpdate(callback?: () => void): void;
    render(): import("react").ReactNode;
    takePictureAsync(options?: Record<string, unknown>): Promise<CameraCapturedPicture>;
  }

  export function useCameraPermissions(): [
    CameraPermissionResponse | null,
    () => Promise<CameraPermissionResponse>,
  ];
}
