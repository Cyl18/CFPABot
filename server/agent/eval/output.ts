export interface OutputDump {
  text: string;
  truncated: boolean;
  totalBytes: number;
}

export class OutputSink {
  private head = "";
  private tail = "";
  private total = 0;

  constructor(private readonly max = 50 * 1024) {}

  push(chunk: string): void {
    this.total += chunk.length;
    const headLimit = Math.floor(this.max / 3);
    const tailLimit = this.max - headLimit;
    let rest = chunk;
    if (this.head.length < headLimit) {
      const take = Math.min(headLimit - this.head.length, rest.length);
      this.head += rest.slice(0, take);
      rest = rest.slice(take);
    }
    if (rest.length === 0) return;
    this.tail += rest;
    if (this.tail.length > tailLimit) this.tail = this.tail.slice(-tailLimit);
  }

  dump(): OutputDump {
    const dropped = this.total - this.head.length - this.tail.length;
    if (dropped <= 0) return { text: this.head + this.tail, truncated: false, totalBytes: this.total };
    return {
      text: `${this.head}\n[... ${dropped} 字符已省略 ...]\n${this.tail}`,
      truncated: true,
      totalBytes: this.total,
    };
  }
}
