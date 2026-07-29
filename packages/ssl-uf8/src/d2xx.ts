import { dlopen, FFIType } from "bun:ffi";

const SSL_VENDOR_ID = 0x31e9;
const UF8_PRODUCT_ID = 0x0021;
const OPEN_BY_SERIAL_NUMBER = 1;

export const DEFAULT_D2XX_LIBRARY_PATH =
  "/Applications/SSL 360.app/Contents/Resources/ssld2xx.dylib";

export type Uf8TransportOptions = {
  d2xxLibraryPath?: string;
};

const d2xxSymbols = {
  FT_SetVIDPID: {
    args: [FFIType.u32, FFIType.u32],
    returns: FFIType.u32,
  },
  FT_CreateDeviceInfoList: {
    args: [FFIType.ptr],
    returns: FFIType.u32,
  },
  FT_GetDeviceInfoDetail: {
    args: [
      FFIType.u32,
      FFIType.ptr,
      FFIType.ptr,
      FFIType.ptr,
      FFIType.ptr,
      FFIType.ptr,
      FFIType.ptr,
      FFIType.ptr,
    ],
    returns: FFIType.u32,
  },
  FT_OpenEx: {
    args: [FFIType.ptr, FFIType.u32, FFIType.ptr],
    returns: FFIType.u32,
  },
  FT_Close: {
    args: [FFIType.u64],
    returns: FFIType.u32,
  },
  FT_Write: {
    args: [FFIType.u64, FFIType.ptr, FFIType.u32, FFIType.ptr],
    returns: FFIType.u32,
  },
  FT_Read: {
    args: [FFIType.u64, FFIType.ptr, FFIType.u32, FFIType.ptr],
    returns: FFIType.u32,
  },
  FT_GetStatus: {
    args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.ptr],
    returns: FFIType.u32,
  },
  FT_SetBaudRate: {
    args: [FFIType.u64, FFIType.u32],
    returns: FFIType.u32,
  },
  FT_SetDataCharacteristics: {
    args: [FFIType.u64, FFIType.u8, FFIType.u8, FFIType.u8],
    returns: FFIType.u32,
  },
  FT_SetFlowControl: {
    args: [FFIType.u64, FFIType.u16, FFIType.u8, FFIType.u8],
    returns: FFIType.u32,
  },
  FT_SetTimeouts: {
    args: [FFIType.u64, FFIType.u32, FFIType.u32],
    returns: FFIType.u32,
  },
  FT_SetLatencyTimer: {
    args: [FFIType.u64, FFIType.u8],
    returns: FFIType.u32,
  },
  FT_Purge: {
    args: [FFIType.u64, FFIType.u32],
    returns: FFIType.u32,
  },
} as const;

function loadD2xxLibrary(options: Uf8TransportOptions) {
  return dlopen(
    options.d2xxLibraryPath ?? DEFAULT_D2XX_LIBRARY_PATH,
    d2xxSymbols,
  );
}

type D2xxLibrary = ReturnType<
  typeof loadD2xxLibrary
>;

export type Uf8DeviceInfo = {
  serial: string;
  description: string;
  flags: number;
  type: number;
  id: number;
  locationId: number;
};

export function listUf8Devices(
  options: Uf8TransportOptions = {},
): readonly Uf8DeviceInfo[] {
  const library = loadD2xxLibrary(options);
  try {
    selectUf8UsbIdentity(library);
    const countOutput = new Uint32Array(1);
    assertD2xxStatus(
      "FT_CreateDeviceInfoList",
      library.symbols.FT_CreateDeviceInfoList(countOutput),
    );

    const count = requiredOutput("device count", countOutput[0]);
    const devices: Uf8DeviceInfo[] = [];
    for (let index = 0; index < count; index += 1) {
      devices.push(readDeviceInfo(library, index));
    }
    return devices;
  } finally {
    library.close();
  }
}

export class Uf8D2xxDevice {
  readonly serial: string;
  readonly #library: D2xxLibrary;
  readonly #handle: bigint;
  #closed = false;

  private constructor(
    serial: string,
    library: D2xxLibrary,
    handle: bigint,
  ) {
    this.serial = serial;
    this.#library = library;
    this.#handle = handle;
  }

  static open(
    serial: string,
    options: Uf8TransportOptions = {},
  ): Uf8D2xxDevice {
    const library = loadD2xxLibrary(options);
    const handleOutput = new BigUint64Array(1);
    try {
      selectUf8UsbIdentity(library);
      const serialCString = new TextEncoder().encode(`${serial}\0`);
      assertD2xxStatus(
        "FT_OpenEx",
        library.symbols.FT_OpenEx(
          serialCString,
          OPEN_BY_SERIAL_NUMBER,
          handleOutput,
        ),
      );
      const handle = handleOutput[0];
      if (handle === undefined || handle === 0n) {
        throw new Error("FT_OpenEx returned an invalid UF8 handle");
      }
      configureUf8Connection(library, handle);
      return new Uf8D2xxDevice(serial, library, handle);
    } catch (error) {
      const handle = handleOutput[0];
      if (handle !== undefined && handle !== 0n) {
        library.symbols.FT_Close(handle);
      }
      library.close();
      throw error;
    }
  }

  write(frame: Uint8Array): void {
    if (this.#closed) {
      throw new Error("Cannot write to a closed UF8");
    }
    const bytesWritten = new Uint32Array(1);
    assertD2xxStatus(
      "FT_Write",
      this.#library.symbols.FT_Write(
        this.#handle,
        frame,
        frame.byteLength,
        bytesWritten,
      ),
    );
    if (bytesWritten[0] !== frame.byteLength) {
      throw new Error(
        `FT_Write sent ${bytesWritten[0]} of ${frame.byteLength} UF8 bytes`,
      );
    }
  }

  readAvailable(): Uint8Array {
    if (this.#closed) {
      throw new Error("Cannot read from a closed UF8");
    }
    const receiveBytes = new Uint32Array(1);
    const transmitBytes = new Uint32Array(1);
    const eventStatus = new Uint32Array(1);
    assertD2xxStatus(
      "FT_GetStatus",
      this.#library.symbols.FT_GetStatus(
        this.#handle,
        receiveBytes,
        transmitBytes,
        eventStatus,
      ),
    );
    const byteCount = requiredOutput("receive byte count", receiveBytes[0]);
    if (byteCount === 0) {
      return new Uint8Array();
    }

    const buffer = new Uint8Array(byteCount);
    const bytesRead = new Uint32Array(1);
    assertD2xxStatus(
      "FT_Read",
      this.#library.symbols.FT_Read(
        this.#handle,
        buffer,
        buffer.byteLength,
        bytesRead,
      ),
    );
    const readCount = requiredOutput("read byte count", bytesRead[0]);
    if (readCount !== byteCount) {
      throw new Error(`FT_Read received ${readCount} of ${byteCount} UF8 bytes`);
    }
    return buffer;
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    try {
      assertD2xxStatus(
        "FT_Close",
        this.#library.symbols.FT_Close(this.#handle),
      );
    } finally {
      this.#library.close();
    }
  }
}

function selectUf8UsbIdentity(library: D2xxLibrary): void {
  assertD2xxStatus(
    "FT_SetVIDPID",
    library.symbols.FT_SetVIDPID(SSL_VENDOR_ID, UF8_PRODUCT_ID),
  );
}

function configureUf8Connection(
  library: D2xxLibrary,
  handle: bigint,
): void {
  assertD2xxStatus(
    "FT_SetDataCharacteristics",
    library.symbols.FT_SetDataCharacteristics(handle, 8, 0, 0),
  );
  assertD2xxStatus(
    "FT_SetFlowControl",
    library.symbols.FT_SetFlowControl(handle, 0, 17, 19),
  );
  assertD2xxStatus(
    "FT_SetBaudRate",
    library.symbols.FT_SetBaudRate(handle, 115200),
  );
  assertD2xxStatus(
    "FT_SetTimeouts",
    library.symbols.FT_SetTimeouts(handle, 4000, 4000),
  );
  assertD2xxStatus(
    "FT_SetLatencyTimer",
    library.symbols.FT_SetLatencyTimer(handle, 2),
  );
  assertD2xxStatus("FT_Purge", library.symbols.FT_Purge(handle, 3));
}

function readDeviceInfo(
  library: D2xxLibrary,
  index: number,
): Uf8DeviceInfo {
  const flags = new Uint32Array(1);
  const type = new Uint32Array(1);
  const id = new Uint32Array(1);
  const locationId = new Uint32Array(1);
  const serial = new Uint8Array(16);
  const description = new Uint8Array(64);
  const handle = new BigUint64Array(1);
  assertD2xxStatus(
    "FT_GetDeviceInfoDetail",
    library.symbols.FT_GetDeviceInfoDetail(
      index,
      flags,
      type,
      id,
      locationId,
      serial,
      description,
      handle,
    ),
  );
  return {
    serial: decodeCString(serial),
    description: decodeCString(description),
    flags: requiredOutput("flags", flags[0]),
    type: requiredOutput("type", type[0]),
    id: requiredOutput("id", id[0]),
    locationId: requiredOutput("location ID", locationId[0]),
  };
}

function decodeCString(buffer: Uint8Array): string {
  const terminator = buffer.indexOf(0);
  const end = terminator === -1 ? buffer.length : terminator;
  return new TextDecoder().decode(buffer.subarray(0, end));
}

function requiredOutput(label: string, value: number | undefined): number {
  if (value === undefined) {
    throw new Error(`D2XX did not return ${label}`);
  }
  return value;
}

function assertD2xxStatus(operation: string, status: number): void {
  if (status !== 0) {
    throw new Error(`${operation} failed: ${d2xxStatusName(status)} (${status})`);
  }
}

function d2xxStatusName(status: number): string {
  const names = [
    "FT_OK",
    "FT_INVALID_HANDLE",
    "FT_DEVICE_NOT_FOUND",
    "FT_DEVICE_NOT_OPENED",
    "FT_IO_ERROR",
    "FT_INSUFFICIENT_RESOURCES",
    "FT_INVALID_PARAMETER",
    "FT_INVALID_BAUD_RATE",
    "FT_DEVICE_NOT_OPENED_FOR_ERASE",
    "FT_DEVICE_NOT_OPENED_FOR_WRITE",
    "FT_FAILED_TO_WRITE_DEVICE",
    "FT_EEPROM_READ_FAILED",
    "FT_EEPROM_WRITE_FAILED",
    "FT_EEPROM_ERASE_FAILED",
    "FT_EEPROM_NOT_PRESENT",
    "FT_EEPROM_NOT_PROGRAMMED",
    "FT_INVALID_ARGS",
    "FT_NOT_SUPPORTED",
    "FT_OTHER_ERROR",
    "FT_DEVICE_LIST_NOT_READY",
  ];
  return names[status] ?? "FT_UNKNOWN_STATUS";
}
