import type {
  ActiveTask,
  HardwareEvent,
  PushPathTask,
} from "../shared/domain.ts";

type MidiStatus = "idle" | "requesting" | "ready" | "unsupported" | "error";

export type MidiDeviceOption = {
  id: string;
  label: string;
};

type MidiCcBinding = {
  midiChannel: number;
  controller: number;
};

export type PushGridBinding = {
  midiChannel: number;
  bottomLeftNote: number;
  xStep: number;
  yStep: number;
};

type MidiConfiguration = {
  uf8InputId: string | null;
  uf8Faders: readonly (MidiCcBinding | null)[];
  pushInputId: string | null;
  pushOutputId: string | null;
  pushGrid: PushGridBinding | null;
};

type Uf8LearnState = {
  kind: "uf8-bank";
  nextChannel: number;
  bindings: (MidiCcBinding | null)[];
};

type PushLearnState = {
  kind: "push-grid";
  notes: number[];
  midiChannel: number | null;
};

type LearnState = Uf8LearnState | PushLearnState | null;

export type MidiBridgeView = {
  status: MidiStatus;
  error: string;
  inputs: readonly MidiDeviceOption[];
  outputs: readonly MidiDeviceOption[];
  configuration: MidiConfiguration;
  learnText: string;
};

const STORAGE_KEY = "synthteam-midi-v1";

export class MidiBridge {
  readonly #onHardwareEvent: (event: HardwareEvent) => void;
  readonly #onChange: () => void;
  #status: MidiStatus;
  #error = "";
  #access: MIDIAccess | null = null;
  #configuration = loadConfiguration();
  #learn: LearnState = null;
  #litPushNotes: number[] = [];
  #lastPushSignature = "";

  constructor(
    onHardwareEvent: (event: HardwareEvent) => void,
    onChange: () => void,
  ) {
    this.#onHardwareEvent = onHardwareEvent;
    this.#onChange = onChange;
    this.#status =
      typeof navigator.requestMIDIAccess === "function"
        ? "idle"
        : "unsupported";
  }

  view(): MidiBridgeView {
    return {
      status: this.#status,
      error: this.#error,
      inputs: this.#deviceOptions("input"),
      outputs: this.#deviceOptions("output"),
      configuration: this.#configuration,
      learnText: this.#learnText(),
    };
  }

  async requestAccess(): Promise<void> {
    if (typeof navigator.requestMIDIAccess !== "function") {
      this.#status = "unsupported";
      this.#onChange();
      return;
    }
    this.#status = "requesting";
    this.#error = "";
    this.#onChange();
    try {
      const access = await navigator.requestMIDIAccess();
      this.#access = access;
      this.#status = "ready";
      access.onstatechange = () => {
        this.#bindInputs();
        this.#onChange();
      };
      this.#bindInputs();
    } catch (error) {
      this.#status = "error";
      this.#error =
        error instanceof Error ? error.message : "MIDI permission was denied";
    }
    this.#onChange();
  }

  setUf8Input(id: string | null): void {
    this.#configuration = {
      ...this.#configuration,
      uf8InputId: id,
      uf8Faders:
        id === this.#configuration.uf8InputId
          ? this.#configuration.uf8Faders
          : emptyFaderBindings(),
    };
    this.#learn = null;
    this.#saveAndBind();
  }

  setPushInput(id: string | null): void {
    this.#configuration = {
      ...this.#configuration,
      pushInputId: id,
      pushGrid:
        id === this.#configuration.pushInputId
          ? this.#configuration.pushGrid
          : null,
    };
    this.#learn = null;
    this.#saveAndBind();
  }

  setPushOutput(id: string | null): void {
    this.#clearPushLights();
    this.#configuration = {
      ...this.#configuration,
      pushOutputId: id,
    };
    this.#lastPushSignature = "";
    this.#save();
    this.#onChange();
  }

  learnUf8Bank(): void {
    if (this.#configuration.uf8InputId === null) {
      this.#error = "Select the UF8 MIDI input first";
      this.#onChange();
      return;
    }
    this.#error = "";
    this.#learn = {
      kind: "uf8-bank",
      nextChannel: 0,
      bindings: [...emptyFaderBindings()],
    };
    this.#onChange();
  }

  learnPushGrid(): void {
    if (this.#configuration.pushInputId === null) {
      this.#error = "Select the Push User input first";
      this.#onChange();
      return;
    }
    this.#error = "";
    this.#learn = { kind: "push-grid", notes: [], midiChannel: null };
    this.#onChange();
  }

  cancelLearn(): void {
    this.#learn = null;
    this.#onChange();
  }

  syncMission(tasks: readonly ActiveTask[]): void {
    const task = tasks.find(
      (candidate): candidate is PushPathTask =>
        candidate.kind === "push-path",
    );
    const grid = this.#configuration.pushGrid;
    const output = this.#pushOutput();
    if (task === undefined || grid === null || output === null) {
      this.#clearPushLights();
      this.#lastPushSignature = "";
      return;
    }
    const signature = `${task.id}:${task.progress}:${output.id}`;
    if (signature === this.#lastPushSignature) {
      return;
    }
    this.#clearPushLights();
    const notes: number[] = [];
    for (let index = 0; index < task.path.length; index += 1) {
      const point = task.path[index];
      if (point === undefined) {
        throw new Error("Push path contains a missing point");
      }
      const note =
        grid.bottomLeftNote + point.x * grid.xStep + point.y * grid.yStep;
      const velocity =
        index < task.progress ? 2 : index === task.progress ? 127 : 18;
      output.send([0x90 | grid.midiChannel, note, velocity]);
      notes.push(note);
    }
    this.#litPushNotes = notes;
    this.#lastPushSignature = signature;
  }

  #bindInputs(): void {
    if (this.#access === null) {
      return;
    }
    for (const input of this.#access.inputs.values()) {
      input.onmidimessage = null;
      if (
        input.id === this.#configuration.uf8InputId ||
        input.id === this.#configuration.pushInputId
      ) {
        input.onmidimessage = (event) => {
          if (event.data !== null) {
            this.#handleMessage(input.id, event.data);
          }
        };
      }
    }
  }

  #handleMessage(inputId: string, data: Uint8Array): void {
    const status = data[0];
    const data1 = data[1];
    const data2 = data[2];
    if (status === undefined || data1 === undefined || data2 === undefined) {
      return;
    }
    const messageKind = status & 0xf0;
    const midiChannel = status & 0x0f;

    if (
      this.#learn?.kind === "uf8-bank" &&
      inputId === this.#configuration.uf8InputId &&
      messageKind === 0xb0
    ) {
      this.#learnUf8Control(midiChannel, data1);
      return;
    }
    if (
      this.#learn?.kind === "push-grid" &&
      inputId === this.#configuration.pushInputId &&
      messageKind === 0x90 &&
      data2 > 0
    ) {
      this.#learnPushCorner(midiChannel, data1);
      return;
    }

    if (
      inputId === this.#configuration.uf8InputId &&
      messageKind === 0xb0
    ) {
      const channel = this.#configuration.uf8Faders.findIndex(
        (binding) =>
          binding?.midiChannel === midiChannel &&
          binding.controller === data1,
      );
      if (channel >= 0) {
        this.#onHardwareEvent({
          kind: "uf8-fader",
          channel,
          value: (data2 / 127) * 100,
        });
      }
      return;
    }

    const grid = this.#configuration.pushGrid;
    const isNoteOn = messageKind === 0x90 && data2 > 0;
    const isNoteOff = messageKind === 0x80 || (messageKind === 0x90 && data2 === 0);
    if (
      inputId !== this.#configuration.pushInputId ||
      grid === null ||
      midiChannel !== grid.midiChannel ||
      (!isNoteOn && !isNoteOff)
    ) {
      return;
    }
    const point = pointForNote(grid, data1);
    if (point !== null) {
      this.#onHardwareEvent({
        kind: "push-pad",
        point,
        phase: isNoteOn ? "down" : "up",
        velocity: data2,
      });
    }
  }

  #learnUf8Control(midiChannel: number, controller: number): void {
    const learn = this.#learn;
    if (learn?.kind !== "uf8-bank") {
      return;
    }
    const alreadyCaptured = learn.bindings.some(
      (binding) =>
        binding?.midiChannel === midiChannel &&
        binding.controller === controller,
    );
    if (alreadyCaptured) {
      return;
    }
    learn.bindings[learn.nextChannel] = { midiChannel, controller };
    learn.nextChannel += 1;
    if (learn.nextChannel === 8) {
      this.#configuration = {
        ...this.#configuration,
        uf8Faders: learn.bindings,
      };
      this.#learn = null;
      this.#save();
    }
    this.#onChange();
  }

  #learnPushCorner(midiChannel: number, note: number): void {
    const learn = this.#learn;
    if (learn?.kind !== "push-grid" || learn.notes.includes(note)) {
      return;
    }
    if (learn.midiChannel !== null && learn.midiChannel !== midiChannel) {
      this.#error = "Push corner pads arrived on different MIDI channels";
      this.#learn = null;
      this.#onChange();
      return;
    }
    learn.midiChannel = midiChannel;
    learn.notes.push(note);
    if (learn.notes.length < 3) {
      this.#onChange();
      return;
    }
    const bottomLeft = learn.notes[0];
    const bottomRight = learn.notes[1];
    const topLeft = learn.notes[2];
    if (
      bottomLeft === undefined ||
      bottomRight === undefined ||
      topLeft === undefined
    ) {
      throw new Error("Push calibration lost a corner note");
    }
    const horizontalDelta = bottomRight - bottomLeft;
    const verticalDelta = topLeft - bottomLeft;
    if (horizontalDelta % 7 !== 0 || verticalDelta % 7 !== 0) {
      this.#error = "Push corner notes do not form a regular 8×8 grid";
      this.#learn = null;
      this.#onChange();
      return;
    }
    const xStep = horizontalDelta / 7;
    const yStep = verticalDelta / 7;
    if (xStep === 0 || yStep === 0) {
      this.#error = "Push grid axes must use different note numbers";
      this.#learn = null;
      this.#onChange();
      return;
    }
    this.#configuration = {
      ...this.#configuration,
      pushGrid: {
        midiChannel,
        bottomLeftNote: bottomLeft,
        xStep,
        yStep,
      },
    };
    this.#learn = null;
    this.#save();
    this.#onChange();
  }

  #learnText(): string {
    switch (this.#learn?.kind) {
      case undefined:
        return "";
      case "uf8-bank":
        return `Move UF8 fader ${this.#learn.nextChannel + 1} · ${this.#learn.nextChannel}/8 captured`;
      case "push-grid": {
        const instructions = [
          "Press the Push bottom-left pad",
          "Press the Push bottom-right pad",
          "Press the Push top-left pad",
        ];
        return instructions[this.#learn.notes.length] ?? "";
      }
    }
  }

  #deviceOptions(kind: "input" | "output"): readonly MidiDeviceOption[] {
    if (this.#access === null) {
      return [];
    }
    const ports =
      kind === "input" ? this.#access.inputs : this.#access.outputs;
    return [...ports.values()].map((port) => ({
      id: port.id,
      label: [port.manufacturer, port.name].filter(isNonEmptyString).join(" · "),
    }));
  }

  #pushOutput(): MIDIOutput | null {
    if (
      this.#access === null ||
      this.#configuration.pushOutputId === null
    ) {
      return null;
    }
    return this.#access.outputs.get(this.#configuration.pushOutputId) ?? null;
  }

  #clearPushLights(): void {
    const output = this.#pushOutput();
    const grid = this.#configuration.pushGrid;
    if (output !== null && grid !== null) {
      for (const note of this.#litPushNotes) {
        output.send([0x90 | grid.midiChannel, note, 0]);
      }
    }
    this.#litPushNotes = [];
  }

  #saveAndBind(): void {
    this.#save();
    this.#bindInputs();
    this.#onChange();
  }

  #save(): void {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(this.#configuration),
    );
  }
}

export function pointForNote(
  grid: PushGridBinding,
  note: number,
): { x: number; y: number } | null {
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      if (
        grid.bottomLeftNote + x * grid.xStep + y * grid.yStep ===
        note
      ) {
        return { x, y };
      }
    }
  }
  return null;
}

function emptyFaderBindings(): readonly (MidiCcBinding | null)[] {
  return [null, null, null, null, null, null, null, null];
}

function defaultConfiguration(): MidiConfiguration {
  return {
    uf8InputId: null,
    uf8Faders: emptyFaderBindings(),
    pushInputId: null,
    pushOutputId: null,
    pushGrid: null,
  };
}

function loadConfiguration(): MidiConfiguration {
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (raw === null) {
    return defaultConfiguration();
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (isMidiConfiguration(value)) {
      return value;
    }
  } catch {
    return defaultConfiguration();
  }
  return defaultConfiguration();
}

function isMidiConfiguration(value: unknown): value is MidiConfiguration {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isNullableString(value["uf8InputId"]) &&
    Array.isArray(value["uf8Faders"]) &&
    value["uf8Faders"].length === 8 &&
    value["uf8Faders"].every(isNullableCcBinding) &&
    isNullableString(value["pushInputId"]) &&
    isNullableString(value["pushOutputId"]) &&
    isNullablePushGrid(value["pushGrid"])
  );
}

function isNullableCcBinding(value: unknown): value is MidiCcBinding | null {
  return (
    value === null ||
    (isRecord(value) &&
      isInteger(value["midiChannel"], 0, 15) &&
      isInteger(value["controller"], 0, 127))
  );
}

function isNullablePushGrid(value: unknown): value is PushGridBinding | null {
  return (
    value === null ||
    (isRecord(value) &&
      isInteger(value["midiChannel"], 0, 15) &&
      isInteger(value["bottomLeftNote"], 0, 127) &&
      typeof value["xStep"] === "number" &&
      Number.isInteger(value["xStep"]) &&
      typeof value["yStep"] === "number" &&
      Number.isInteger(value["yStep"]))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

function isInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function isNonEmptyString(value: string | null): value is string {
  return value !== null && value.length > 0;
}
