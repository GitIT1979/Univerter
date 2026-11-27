"""Подставная «Indra» ТОЛЬКО для тестов: повторяет документированный интерфейс
(indra_ocr.load(...) → conv.ocr(gray) → Page с lines/blocks/rotation/skew) без нейросети.
Ответ берётся из JSON-файла (UNIVERTER_FAKE_INDRA_DATA) по размеру изображения.
Ориентацию имитирует по чёрному квадрату в левом верхнем углу «прямой» страницы:
rotation сообщается как угол «против часовой» (условность намеренно противоположна первой догадке сервера)."""
import json
import os

import numpy as np

__version__ = 'fake-0'


class Line:
    def __init__(self, box, text, conf):
        self.box, self.text, self.conf = tuple(box), text, conf


class Page:
    def __init__(self, lines, blocks, rotation=0.0, skew=0.0):
        self.lines = [Line(*l) for l in lines]
        self.blocks = blocks
        self.rotation, self.skew = rotation, skew
        self.text = '\n'.join(l.text for l in self.lines)
        self.markdown = self.text


class _Converter:
    def __init__(self):
        with open(os.environ['UNIVERTER_FAKE_INDRA_DATA'], encoding='utf-8') as f:
            self.data = json.load(f)

    def _marker_rotation(self, gray):
        h, w = gray.shape[:2]
        s = 12
        dark = lambda a: float(a.mean()) < 60
        if dark(gray[:s, :s]): return 0.0           # верх-лево
        if dark(gray[:s, w - s:]): return 90.0      # верх-право: страница повёрнута на 90° по часовой
        if dark(gray[h - s:, w - s:]): return 180.0
        if dark(gray[h - s:, :s]): return 270.0
        return 0.0

    def ocr(self, gray):
        assert gray.ndim == 2 and gray.dtype == np.uint8, 'Indra ждёт серое изображение uint8'
        d = self.data[str(max(gray.shape[:2]))]
        return Page(d['lines'], d.get('blocks', []), self._marker_rotation(gray), d.get('skew', 0.0))


def load(**kwargs):
    return _Converter()
