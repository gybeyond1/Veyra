/* App Store style card controller for the WebView. Layout/gesture adaptation is
 * local; settling uses the MIT-licensed flip-toolkit spring (bundled offline).
 * One geometry model drives opening, interactive dismissal, cancellation and return.
 */
(() => {
  const mix = (a, b, p) => a + (b - a) * p;
  const clamp = value => Math.max(0, Math.min(1, value));
  const rect = value => ({ x: value.left, y: value.top, w: value.width, h: value.height });
  const local = (value, origin) => ({ x: value.left - origin.left, y: value.top - origin.top, w: value.width, h: value.height });
  const interpolate = (a, b, p) => Object.fromEntries(Object.keys(a).map(key => [key, mix(a[key], b[key], p)]));
  const position = value => value.split(' ').map(part => parseFloat(part) / 100);
  const stripIds = node => { node.removeAttribute('id'); node.querySelectorAll('[id]').forEach(child => child.removeAttribute('id')); };

  class CardTransition {
    static capture(trigger) {
      const element = trigger?.closest('.film-card,.history-card,.hero,.category-spotlight');
      if (!element) return null;
      const art = element.querySelector('.poster,.history-poster') || element;
      const image = art.querySelector('.hero-slide:last-child img,img[data-cover]');
      const title = element.querySelector('.film-title,.history-copy strong,.hero-copy h2,.category-spotlight-copy h2,h2');
      const bounds = element.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return null;
      const header = document.querySelector('#app > .app-top').cloneNode(true);
      stripIds(header);
      return {
        element, bounds: rect(bounds), art: rect(art.getBoundingClientRect()),
        title: title ? rect(title.getBoundingClientRect()) : null,
        titleSize: title ? parseFloat(getComputedStyle(title).fontSize) : 12,
        titleText: title?.textContent || '',
        titleColor: title ? getComputedStyle(title).color : getComputedStyle(element).color,
        radius: parseFloat(getComputedStyle(art).borderRadius) || 10,
        image: image?.naturalWidth ? image.currentSrc || image.src : '',
        imageWidth: image?.naturalWidth || 1, imageHeight: image?.naturalHeight || 1,
        imagePosition: position(image ? getComputedStyle(image).objectPosition : '50% 50%'), header,
        compact: document.getElementById('compact-category').cloneNode(true),
        extras: [...element.querySelectorAll('.poster-score,.film-info,.history-status,.history-hint,.progress,.hero-label,.hero-action,.hero-index,.category-spotlight-copy button')].map(node => {
          const style = getComputedStyle(node);
          return { node: node.cloneNode(true), rect: rect(node.getBoundingClientRect()),
            font: style.font, color: style.color, background: style.backgroundColor, radius: style.borderRadius };
        })
      };
    }

    constructor(options) {
      Object.assign(this, options);
      this.phase = 'ready';
      this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
      this.onTouchStart = event => this.touchStart(event);
      this.onTouchMove = event => this.touchMove(event);
      this.onTouchEnd = event => this.touchEnd(event);
      this.onTouchCancel = () => { if (this.touch?.dragging) this.cancel(); this.touch = null; };
      this.onClick = event => {
        if (performance.now() < (this.suppressClickUntil || 0) ||
            (this.phase !== 'opened' && !event.target.closest('[data-back]'))) {
          event.preventDefault(); event.stopImmediatePropagation();
        }
      };
      this.app.addEventListener('touchstart', this.onTouchStart, { passive: true, capture: true });
      this.app.addEventListener('touchmove', this.onTouchMove, { passive: false, capture: true });
      this.app.addEventListener('touchend', this.onTouchEnd, { passive: true, capture: true });
      this.app.addEventListener('touchcancel', this.onTouchCancel, { passive: true, capture: true });
      this.app.addEventListener('click', this.onClick, true);
    }

    prepare(opening) {
      this.returning = !opening;
      const origin = this.app.getBoundingClientRect();
      this.width = origin.width; this.height = origin.height;
      this.full = { x: 0, y: 0, w: this.width, h: this.height, radius: 0, shape: 1, contentScale: 1 };
      this.small = { x: this.source.bounds.x - origin.left, y: this.source.bounds.y - origin.top,
        w: this.source.bounds.w, h: this.source.bounds.h, radius: this.source.radius, shape: 0, contentScale: 1 };
      const art = this.content.querySelector('.detail-art');
      const title = this.content.querySelector('.detail-copy h1');
      this.hasTargetArt = Boolean(art); this.hasTargetTitle = Boolean(title);
      this.targetArt = art ? local(art.getBoundingClientRect(), origin) : { x: 0, y: -this.scroll.scrollTop, w: this.width, h: 385 };
      this.targetTitle = title ? local(title.getBoundingClientRect(), origin) : { x: 20, y: 330 - this.scroll.scrollTop, w: this.width - 40, h: 32 };
      this.titleSize = title ? parseFloat(getComputedStyle(title).fontSize) : 26;
      this.titleColor = (title ? getComputedStyle(title).color : getComputedStyle(this.app).color).match(/[\d.]+/g).slice(0, 3).map(Number);
      this.sourceColor = this.source.titleColor.match(/[\d.]+/g).slice(0, 3).map(Number);
      const style = getComputedStyle(this.app);
      this.deviceCorners = ['topLeft', 'topRight', 'bottomRight', 'bottomLeft'].map(name =>
        parseFloat(style.getPropertyValue(`--screen-corner-${name}`)) || 22);
      this.deviceRadius = Math.max(...this.deviceCorners);
      const stage = document.createElement('div');
      stage.className = 'card-transition-stage';
      stage.setAttribute('aria-hidden', 'true');
      stage.appendChild(this.source.header.cloneNode(true));
      const compact = this.source.compact.cloneNode(true);
      stripIds(compact); compact.classList.add('card-background-compact'); stage.appendChild(compact);
      const viewport = document.createElement('div');
      viewport.className = 'card-transition-background';
      const offset = document.createElement('div');
      offset.style.transform = `translateY(${-this.snapshot.scrollTop}px)`;
      offset.appendChild(this.snapshot.pageNode);
      if (this.snapshot.route === 'category') this.snapshot.pageNode.classList.toggle('is-collapsed', Boolean(this.snapshot.compactHeld));
      viewport.appendChild(offset); stage.appendChild(viewport);
      this.app.appendChild(stage);
      viewport.querySelectorAll('.film-row,.filter-row,.home-tag-scroll').forEach((row, index) => {
        row.scrollLeft = this.snapshot.horizontalScroll?.[index] || 0;
      });
      // The real source stays in the background; do not show a duplicate beneath the morph.
      this.sourceVisibility = this.source.element.style.visibility;
      this.source.element.style.visibility = 'hidden';
      const shadow = document.createElement('div');
      shadow.className = 'card-transition-shadow';
      shadow.setAttribute('aria-hidden', 'true');
      shadow.style.width = this.width + 'px'; shadow.style.height = this.height + 'px';
      // Rasterize the soft edge once; changing its radius in draw() repaints the
      // viewport-sized shadow on every frame. Transform/opacity stay composited.
      shadow.style.borderRadius = this.deviceCorners.map(corner => corner + 'px').join(' ');
      this.app.appendChild(shadow); this.shadow = shadow;
      const surface = document.createElement('div');
      surface.className = 'card-transition-surface';
      surface.style.width = `${this.width}px`; surface.style.height = `${this.height}px`;
      const body = document.createElement('div');
      body.className = 'card-transition-body';
      body.style.width = `${this.width}px`; body.style.height = `${this.height}px`;
      const page = document.createElement('div');
      page.className = 'card-transition-page';
      page.style.transform = `translateY(${-this.scroll.scrollTop}px)`;
      const clone = this.content.cloneNode(true);
      stripIds(clone); page.appendChild(clone); body.appendChild(page);
      this.copy = clone.querySelector('.detail-copy');
      this.back = clone.querySelector('.detail-back');
      const photo = document.createElement('div');
      photo.className = 'card-transition-photo';
      photo.style.width = `${this.width}px`; photo.style.height = `${this.height}px`;
      const image = document.createElement('img');
      image.alt = ''; image.src = this.source.image;
      image.hidden = !this.source.image;
      image.style.width = `${this.width}px`;
      image.style.height = `${this.width * this.source.imageHeight / this.source.imageWidth}px`;
      photo.appendChild(image); body.appendChild(photo);
      const label = document.createElement('div');
      label.className = 'card-transition-title';
      label.textContent = title?.textContent || this.source.titleText;
      label.style.fontSize = `${this.titleSize}px`;
      label.style.width = `${this.targetTitle.w}px`;
      body.appendChild(label); surface.appendChild(body); this.app.appendChild(surface);
      const extras = document.createElement('div');
      extras.className = 'card-transition-extras';
      for (const item of this.source.extras) {
        stripIds(item.node);
        Object.assign(item.node.style, { position: 'absolute', left: `${item.rect.x - this.source.bounds.x}px`,
          top: `${item.rect.y - this.source.bounds.y}px`, right: 'auto', bottom: 'auto',
          width: `${item.rect.w}px`, height: `${item.rect.h}px`, margin: '0',
          font: item.font, color: item.color, background: item.background, borderRadius: item.radius });
        extras.appendChild(item.node);
      }
      body.appendChild(extras); this.extras = extras;
      this.stage = stage; this.surface = surface; this.body = body;
      this.photo = photo; this.image = image; this.label = label;
      this.app.classList.add('card-transition-active');
      this.lastShape = null;
      this.current = opening ? { ...this.small } : { ...this.full };
      this.draw(this.current);
    }

    draw(geometry) {
      if (!this.surface) return;
      this.current = geometry;
      const { x, y, w, h, radius } = geometry;
      const p = clamp(geometry.shape);
      const sx = w / this.width, sy = h / this.height;
      this.surface.style.transform = `translate3d(${x}px,${y}px,0) scale(${sx},${sy})`;
      const corners = this.deviceCorners.map(corner => radius * mix(1, corner / this.deviceRadius, p));
      this.surface.style.borderRadius = `${corners.map(corner => `${corner / sx}px`).join(' ')} / ${corners.map(corner => `${corner / sy}px`).join(' ')}`;
      // The shadow is a sibling of the clipped surface, so it can extend naturally.
      this.shadow.style.transform = this.surface.style.transform;
      const lifted = clamp((1 - Math.min(sx, sy)) / .08);
      const merging = clamp(p / .18);
      this.shadow.style.opacity = String(this.returning ? lifted * merging : 0);
      // Counter-scale the page so text and controls never stretch with the card bounds.
      this.body.style.transform = `scale(${geometry.contentScale / sx},${geometry.contentScale / sy})`;
      // During a drag the entire page moves/scales, while its internal layout stays
      // unchanged. Avoid redoing image crops, title colors and opacity on every tick.
      if (p === this.lastShape) return;
      this.lastShape = p;
      this.extras.style.opacity = String((1 - p) * (1 - p));
      if (this.copy) this.copy.style.opacity = String(p * p);
      if (this.back) this.back.style.opacity = String(p * p);
      const sourceArt = { x: this.source.art.x - this.source.bounds.x, y: this.source.art.y - this.source.bounds.y,
        w: this.source.art.w, h: this.source.art.h };
      const art = interpolate(sourceArt, this.targetArt, p);
      this.photo.style.transform = `translate3d(${art.x}px,${art.y}px,0)`;
      this.photo.style.clipPath = `inset(0 ${Math.max(0, this.width - art.w)}px ${Math.max(0, this.height - art.h)}px 0)`;
      // Uniform image scale + moving crop, rather than stretching a portrait into a landscape.
      const imageHeight = this.width * this.source.imageHeight / this.source.imageWidth;
      const scale = Math.max(art.w / this.width, art.h / imageHeight);
      const px = mix(this.source.imagePosition[0] || .5, .5, p);
      const py = mix(this.source.imagePosition[1] || .5, .25, p);
      this.image.style.transform = `translate3d(${(art.w - this.width * scale) * px}px,${(art.h - imageHeight * scale) * py}px,0) scale(${scale})`;
      this.photo.style.opacity = String(this.source.image ? this.hasTargetArt ? 1 : 1 - p : 0);
      this.photo.style.setProperty('--card-shade', String(p));
      this.photo.style.setProperty('--card-photo-height', `${art.h}px`);
      const start = this.source.title ? { x: this.source.title.x - this.source.bounds.x, y: this.source.title.y - this.source.bounds.y,
        w: this.source.title.w, h: this.source.title.h } : this.targetTitle;
      const title = interpolate(start, this.targetTitle, p);
      const fontScale = mix(this.source.titleSize / this.titleSize, 1, p);
      this.label.style.transform = `translate3d(${title.x}px,${title.y}px,0) scale(${fontScale})`;
      this.label.style.color = `rgb(${this.titleColor.map((channel, index) => Math.round(mix(this.sourceColor[index], channel, p))).join(',')})`;
      this.label.style.opacity = String(this.hasTargetTitle ? 1 : 1 - p);
      this.label.style.clipPath = p < .5 ? `inset(0 ${Math.max(0, this.targetTitle.w - start.w / fontScale)}px 0 0)` : 'none';
    }

    stop() {
      this.spring?.destroy(); this.spring = null;
      if (this.frame) cancelAnimationFrame(this.frame);
      this.frame = null;
    }

    settle(target, closing = false) {
      this.stop();
      this.phase = closing ? 'closing' : 'settling';
      const start = { ...this.current };
      const finish = () => {
        this.spring = null;
        this.cleanup();
        this.phase = closing ? 'closed' : 'opened';
        if (closing) this.onClose();
      };
      if (this.reduced) { finish(); return; }
      this.spring = FlipToolkit.spring({
        config: { stiffness: closing ? 360 : 300, damping: 34, overshootClamping: true },
        onUpdate: p => this.draw(interpolate(start, target, clamp(p))), onComplete: finish
      });
    }

    open() {
      this.prepare(true);
      this.phase = 'opening';
      this.settle(this.full);
    }

    begin() {
      if (['closing', 'closed', 'disposed'].includes(this.phase)) return false;
      if (!this.surface) this.prepare(false);
      this.returning = true;
      this.stop(); this.phase = 'dragging'; this.dragBase = { ...this.current };
      return true;
    }

    drag(dx, dy, progress, edge = false) {
      if (this.phase !== 'dragging') return;
      const p = clamp(progress);
      const scale = 1 - .22 * p;
      const base = this.dragBase;
      const geometry = { x: base.x + dx + base.w * (1 - scale) * .5, y: base.y + dy,
        w: base.w * scale, h: base.h * scale,
        radius: mix(base.radius, this.deviceRadius, clamp(p * 5)), shape: base.shape, contentScale: base.contentScale * scale };
      if (edge) geometry.y = base.y + base.h * (1 - scale) * .5;
      this.pendingGeometry = geometry;
      if (!this.frame) this.frame = requestAnimationFrame(() => {
        this.frame = null; this.draw(this.pendingGeometry);
      });
    }

    predictive(progress, fromRight) {
      this.drag((fromRight ? -1 : 1) * this.width * progress * .48, 0, progress, true);
    }

    flush() {
      if (!this.frame) return;
      cancelAnimationFrame(this.frame); this.frame = null;
      this.draw(this.pendingGeometry);
    }

    cancel() { this.flush(); if (this.surface) this.settle(this.full); }
    close() {
      if (this.phase === 'closing') return;
      if (!this.surface) this.prepare(false);
      this.returning = true;
      this.flush(); this.settle(this.small, true);
    }

    touchStart(event) {
      if (this.phase !== 'opened' || event.touches.length !== 1 ||
          event.target.closest('button,input,.detail-description,#auth-overlay,#confirm-overlay,#update-overlay') || !this.isDetail()) return;
      const point = event.touches[0];
      const bounds = this.app.getBoundingClientRect();
      const statusInset = parseFloat(getComputedStyle(this.app).getPropertyValue('--status-bar-height')) || 0;
      // Leave the system's status/navigation gestures and side back gestures to Android.
      if (point.clientX < 24 || point.clientX > bounds.right - 24 ||
          point.clientY < bounds.top + statusInset + 24 || point.clientY > bounds.bottom - 24) return;
      this.touch = { x: point.clientX, y: point.clientY, lastY: point.clientY, at: event.timeStamp, velocity: 0, dragging: false };
    }

    touchMove(event) {
      const touch = this.touch;
      if (!touch || event.touches.length !== 1) return;
      const point = event.touches[0];
      const dx = point.clientX - touch.x, dy = point.clientY - touch.y;
      if (!touch.dragging) {
        if (this.scroll.scrollTop > 1) { touch.x = point.clientX; touch.y = point.clientY; return; }
        if (dy <= 10 || dy <= Math.abs(dx) * 1.2) return;
        if (!this.begin()) return;
        touch.dragging = true;
      }
      if (event.cancelable) event.preventDefault();
      const elapsed = event.timeStamp - touch.at;
      if (elapsed > 0) touch.velocity = (point.clientY - touch.lastY) / elapsed;
      touch.at = event.timeStamp; touch.lastY = point.clientY;
      touch.distance = Math.max(0, dy);
      this.drag(dx * .4, touch.distance, touch.distance / (this.height * .55));
    }

    touchEnd(event) {
      const touch = this.touch; this.touch = null;
      if (!touch?.dragging) return;
      this.suppressClickUntil = performance.now() + 400;
      const velocity = event.timeStamp - touch.at < 100 ? touch.velocity : 0;
      if (touch.distance > this.height * .14 || (touch.distance > 35 && velocity > .65)) this.close();
      else this.cancel();
    }

    cleanup() {
      this.source.element.style.visibility = this.sourceVisibility || '';
      if (this.stage?.contains(this.snapshot.pageNode)) this.snapshot.pageNode.remove();
      this.stage?.remove(); this.surface?.remove(); this.shadow?.remove();
      this.stage = null; this.surface = null; this.shadow = null;
      this.app.classList.remove('card-transition-active');
    }

    dispose() {
      this.stop(); this.cleanup(); this.touch = null; this.phase = 'disposed';
      this.app.removeEventListener('touchstart', this.onTouchStart, true);
      this.app.removeEventListener('touchmove', this.onTouchMove, true);
      this.app.removeEventListener('touchend', this.onTouchEnd, true);
      this.app.removeEventListener('touchcancel', this.onTouchCancel, true);
      this.app.removeEventListener('click', this.onClick, true);
    }
  }
  window.HGCardTransition = CardTransition;
})();
