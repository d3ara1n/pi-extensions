import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import { PeekReportParser, type ParsedPeekReport } from "./report-parser.ts";

/** @internal Feed actual text deltas to the parser; event.partial is live mutable provider state. */
export class ReportStream {
  private blocks = new Map<number, string>();
  private parser: PeekReportParser;
  private latestFedBlock = -1;

  constructor(onReport: (delta: string) => void) {
    this.parser = new PeekReportParser(onReport);
  }

  push(event: AssistantMessageEvent): void {
    if (event.type === "text_start") {
      if (!this.blocks.has(event.contentIndex)) this.blocks.set(event.contentIndex, "");
    } else if (event.type === "text_delta") {
      this.append(event.contentIndex, (this.blocks.get(event.contentIndex) ?? "") + event.delta);
    } else if (event.type === "text_end") {
      this.append(event.contentIndex, event.content);
    }
  }

  /** Fill content omitted by a provider's deltas without trusting its mutable partial snapshots. */
  settle(message: AssistantMessage): void {
    for (const [index, block] of message.content.entries()) {
      if (block.type === "text") this.append(index, block.text);
    }
  }

  finish(message: AssistantMessage): ParsedPeekReport {
    this.settle(message);
    const lastText = message.content.findLast((block) => block.type === "text");
    return this.parser.finish(lastText?.type === "text" ? lastText.text : "");
  }

  private append(index: number, text: string): void {
    const previous = this.blocks.get(index) ?? "";
    if (!text.startsWith(previous))
      throw new Error("peek: provider revised text after it was received.");
    if (text.length > previous.length && index < this.latestFedBlock) {
      throw new Error(
        "peek: provider filled an earlier text block after later blocks were streamed.",
      );
    }
    if (text.length > previous.length) this.latestFedBlock = index;
    this.blocks.set(index, text);
    this.parser.push(text.slice(previous.length));
  }
}
