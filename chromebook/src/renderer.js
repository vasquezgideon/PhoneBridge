// PhoneBridge — draws JPEG tiles from the phone onto the canvas, in order.
(function (root) {
  'use strict';
  const PB = (root.PB = root.PB || {});
  const P = PB.protocol;

  class Renderer extends EventTarget {
    constructor(canvas) {
      super();
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d', { alpha: false });
      this.chain = Promise.resolve();
      this.frames = 0;
      this.tiles = 0;
      this.bytes = 0;
      this.hasImage = false;
    }

    emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

    draw(t) {
      this.bytes += t.jpeg.length;
      this.chain = this.chain.then(async () => {
        if (this.canvas.width !== t.fullW || this.canvas.height !== t.fullH) {
          this.canvas.width = t.fullW;
          this.canvas.height = t.fullH;
          this.ctx.fillStyle = '#fff';
          this.ctx.fillRect(0, 0, t.fullW, t.fullH);
          this.emit('resize', { w: t.fullW, h: t.fullH });
        }
        const bmp = await createImageBitmap(new Blob([t.jpeg], { type: 'image/jpeg' }));
        this.ctx.drawImage(bmp, t.x, t.y, t.w, t.h);
        bmp.close();
        this.tiles++;
        if (t.flags & P.TILE_END) {
          this.frames++;
          if (!this.hasImage) { this.hasImage = true; this.emit('first-frame'); }
          this.emit('frame', t.frameId);
        }
      }).catch((e) => this.emit('error', e));
    }

    reset() {
      this.hasImage = false;
    }
  }

  PB.Renderer = Renderer;
})(typeof window !== 'undefined' ? window : globalThis);
