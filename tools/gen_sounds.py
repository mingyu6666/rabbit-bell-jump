# -*- coding: utf-8 -*-
"""
生成《小兔跳铃铛》小程序所需的程序化音效（WAV, 11025Hz, 16bit, mono）。
运行：python tools/gen_sounds.py
依赖：仅标准库（wave / math / struct）
"""
import wave
import math
import struct
import os

SR = 11025
OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets", "sounds")


def write_wav(path, samples):
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        frames = bytearray()
        for s in samples:
            frames += struct.pack("<h", max(-32767, min(32767, int(s * 32767))))
        w.writeframes(bytes(frames))
    print("written:", path, len(samples) / SR, "s")


def bell(duration=0.18):
    """踩铃铛：清脆的叮，高频双正弦快速衰减"""
    n = int(SR * duration)
    out = []
    for i in range(n):
        t = i / SR
        env = math.exp(-t * 18) * (1 - t / duration)
        s = 0.6 * math.sin(2 * math.pi * 1760 * t) + 0.4 * math.sin(2 * math.pi * 2640 * t)
        out.append(s * env * 0.8)
    return out


def star():
    """星星：两个快速短音，间隔 0.16s"""
    n = int(SR * 0.32)
    out = []
    for i in range(n):
        t = i / SR
        if t < 0.16:
            env = math.exp(-t * 22) * (1 - t / 0.16)
            s = 0.6 * math.sin(2 * math.pi * 1318.5 * t) + 0.4 * math.sin(2 * math.pi * 1975.5 * t)
        else:
            tt = t - 0.16
            env = math.exp(-tt * 22) * (1 - tt / 0.16)
            s = 0.6 * math.sin(2 * math.pi * 1760 * tt) + 0.4 * math.sin(2 * math.pi * 2637 * tt)
        out.append(s * env * 0.7)
    return out


def fail():
    """失败：低频下滑音"""
    n = int(SR * 0.5)
    out = []
    for i in range(n):
        t = i / SR
        f = 420 - 260 * (t / 0.5)
        env = (1 - t / 0.5) * 0.5
        s = 0.8 * math.sin(2 * math.pi * f * t) + 0.2 * math.sin(2 * math.pi * f * 0.5 * t)
        out.append(s * env * 0.7)
    return out


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    write_wav(os.path.join(OUT_DIR, "bell.wav"), bell())
    write_wav(os.path.join(OUT_DIR, "star.wav"), star())
    write_wav(os.path.join(OUT_DIR, "fail.wav"), fail())


if __name__ == "__main__":
    main()
