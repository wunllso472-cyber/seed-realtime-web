// 麦克风采集：重采样到 16kHz 单声道 int16，每 20ms（320 个采样 / 640 字节）输出一包，同时回传 RMS 电平
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetRate = 16000;
    this.ratio = sampleRate / this.targetRate; // 输入采样率 / 目标采样率
    this.frame = 320;
    this.buf = new Int16Array(this.frame);
    this.n = 0;
    this.pos = 0;
    this.acc = 0;
    this.accN = 0;
    this.sumSq = 0;
    this.peak = 0;
  }

  push(s) {
    s = Math.max(-1, Math.min(1, s));
    this.sumSq += s * s;
    const a = Math.abs(s);
    if (a > this.peak) this.peak = a;
    this.buf[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
    if (this.n === this.frame) {
      const out = this.buf;
      const rms = Math.sqrt(this.sumSq / this.frame);
      this.port.postMessage({ pcm: out.buffer, rms, peak: this.peak }, [out.buffer]);
      this.buf = new Int16Array(this.frame);
      this.n = 0;
      this.sumSq = 0;
      this.peak = 0;
    }
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    if (this.ratio <= 1) {
      // 输入采样率不高于 16k：最近邻上采样
      const step = 1 / this.ratio;
      for (let i = 0; i < ch.length; i++) {
        this.pos += step;
        while (this.pos >= 1) { this.push(ch[i]); this.pos -= 1; }
      }
      return true;
    }
    // 下采样：区间平均（简单抗混叠）
    for (let i = 0; i < ch.length; i++) {
      this.acc += ch[i];
      this.accN++;
      this.pos += 1;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        this.push(this.acc / this.accN);
        this.acc = 0;
        this.accN = 0;
      }
    }
    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
