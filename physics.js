(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.QixingPhysics = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const TAU = Math.PI * 2;
  const FIXED_STEP = 1 / 240;
  const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
  const cross = (a, b) => a.x * b.y - a.y * b.x;

  /** Numbered disk rigid bodies inside a circular drum, with an actual outlet. */
  class BallDrumPhysics {
    constructor({ count, numbers = null, friction = 0.20, restitution = 0.72 } = {}) {
      if (numbers !== null) {
        if (!Array.isArray(numbers) || new Set(numbers).size !== numbers.length ||
            !numbers.every((number) => Number.isInteger(number) && number >= 0 && number <= 99)) {
          throw new RangeError('numbers must be distinct integers between zero and 99');
        }
        if (count !== undefined && count !== numbers.length) throw new RangeError('count must match numbers');
        count = numbers.length;
      }
      if (!Number.isInteger(count) || count < 2 || count > 35) throw new RangeError('count must be 2–35');
      if (!Number.isFinite(friction) || friction < 0 || friction > 1 ||
          !Number.isFinite(restitution) || restitution < 0 || restitution > 1) {
        throw new RangeError('friction and restitution must be between zero and one');
      }
      this.count = count;
      this.numbers = numbers ? [...numbers] : Array.from({ length: count }, (_, index) => index);
      this.friction = friction;
      this.restitution = restitution;
      this.radius = 1;
      this.ballRadius = count > 20 ? 0.080 : count > 10 ? 0.105 : 0.12;
      this.gravity = 4.5;
      this.rotorRadius = 0.66;
      this.rotorBladeRadius = 0.035;
      this.rotorHubRadius = 0.11;
      // A metal shaft/flywheel is substantially heavier than the hollow
      // numbered balls, but contacts still transfer angular momentum back.
      this.rotorInertia = 18;
      this.gateHalfWidth = this.ballRadius * 1.18;
      this.gateY = Math.sqrt(1 - this.gateHalfWidth ** 2);
      this.tubeBottom = 1.60;
      this.captureLine = 1.12;
      this.mixingDuration = 6.25;
      this.reset();
    }

    reset() {
      this.rotorAngle = 0;
      this.rotorVelocity = 0;
      this.elapsed = 0;
      this.gateOpen = false;
      this.captured = null;
      this.settled = true;
      this.impactCount = 0;
      this.lastImpulse = 0;
      this.lastImpact = -Infinity;
      this.captureEvent = null;
      this._accumulator = 0;
      this._restTime = 0;
      this._driveVelocity = 0;
      this.balls = this._initialBalls();
      this._settleInitialBalls();
      this.impactCount = 0;
      this.lastImpulse = 0;
      this.lastImpact = -Infinity;
      return this;
    }

    _settleInitialBalls() {
      // The idle illustration is a real supported pile. Let gravity settle
      // the disks against a locked motor axle with the outlet closed.
      const restitution = this.restitution;
      this.restitution = 0;
      const h = FIXED_STEP;
      const segments = this.getRotorSegments();
      for (let frame = 0; frame < 720; frame++) {
        for (const ball of this.balls) {
          ball.vy += this.gravity * h;
          ball.vx *= Math.exp(-3 * h);
          ball.vy *= Math.exp(-3 * h);
          ball.x += ball.vx * h;
          ball.y += ball.vy * h;
        }
        for (let iteration = 0; iteration < 7; iteration++) {
          for (let i = 0; i < this.balls.length; i++) {
            const a = this.balls[i];
            this._chamberContact(a);
            this._rotorContact(a, segments);
            this.rotorVelocity = 0;
            for (let j = i + 1; j < this.balls.length; j++) this._ballContact(a, this.balls[j]);
          }
        }
      }
      this.restitution = restitution;
      for (const ball of this.balls) {
        this._chamberContact(ball);
        ball.vx = 0;
        ball.vy = 0;
        ball.angularVelocity = 0;
      }
    }

    _initialBalls() {
      const r = this.ballRadius;
      const spacing = r * 2 + 0.027;
      const candidates = [];
      const limit = this.count > 20 ? Math.ceil((1 - r) / spacing) : 4;
      for (let row = -limit; row <= limit; row++) {
        const y = row * spacing * 0.866;
        for (let column = -limit; column <= limit; column++) {
          const x = (column + (Math.abs(row) % 2) * 0.5) * spacing;
          const distance = Math.hypot(x, y);
          if (distance > 1 - r - 0.025 || distance < this.rotorHubRadius + r + 0.02) continue;
          if (Math.abs(y) < r + this.rotorBladeRadius + 0.01 && Math.abs(x) < this.rotorRadius + r) continue;
          candidates.push({ x, y });
        }
      }
      candidates.sort((a, b) => a.y - b.y || a.x - b.x);
      if (candidates.length < this.count) throw new RangeError('Too many balls for the chamber');
      return candidates.slice(0, this.count).map((position, index) => ({
        number: this.numbers[index], x: position.x, y: position.y, vx: 0, vy: 0,
        radius: r, mass: 1, angle: 0, angularVelocity: 0, captured: false
      }));
    }

    kick(velocity) {
      if (!Number.isFinite(velocity)) throw new TypeError('velocity must be finite');
      if (this.captured) this.reset();
      this._driveVelocity = clamp(velocity, -30, 30);
      this.rotorVelocity = this._driveVelocity;
      this.elapsed = 0;
      this.gateOpen = false;
      this.settled = false;
      this.captureEvent = null;
      this.impactCount = 0;
      this.lastImpulse = 0;
      this.lastImpact = -Infinity;
      this._accumulator = 0;
      this._restTime = 0;
      return this;
    }

    getValue() {
      return this.captured ? this.captured.number : null;
    }

    getRotorSegments() {
      const x = Math.cos(this.rotorAngle) * this.rotorRadius;
      const y = Math.sin(this.rotorAngle) * this.rotorRadius;
      return [
        { a: { x: 0, y: 0 }, b: { x, y }, radius: this.rotorBladeRadius },
        { a: { x: 0, y: 0 }, b: { x: -x, y: -y }, radius: this.rotorBladeRadius }
      ];
    }

    getEnergy() {
      let result = this.rotorInertia * this.rotorVelocity ** 2 * 0.5;
      for (const ball of this.balls) {
        result += ball.mass * (ball.vx ** 2 + ball.vy ** 2) * 0.5 - ball.mass * this.gravity * ball.y;
      }
      return result;
    }

    step(dt) {
      if (!Number.isFinite(dt) || dt < 0) throw new RangeError('dt must be finite and non-negative');
      if (dt === 0 || this.settled) return this;
      this._accumulator += dt;
      while (this._accumulator + 1e-12 >= FIXED_STEP && !this.settled) {
        this._accumulator = Math.max(0, this._accumulator - FIXED_STEP);
        let maximumSpeed = Math.abs(this.rotorVelocity) * this.rotorRadius;
        for (const ball of this.balls) maximumSpeed = Math.max(maximumSpeed, Math.hypot(ball.vx, ball.vy));
        const subdivisions = Math.max(1, Math.ceil(maximumSpeed * FIXED_STEP / (this.ballRadius * 0.20)));
        const h = FIXED_STEP / subdivisions;
        for (let index = 0; index < subdivisions && !this.settled; index++) this._advance(h);
      }
      return this;
    }

    _recordImpact(impulse, speed) {
      if (speed > 0.65 && impulse > 0.08 && this.elapsed - this.lastImpact > 0.015) {
        this.impactCount++;
        this.lastImpulse = impulse;
        this.lastImpact = this.elapsed;
      }
    }

    _wallImpulse(ball, nx, ny, restitution = this.restitution) {
      const normalSpeed = ball.vx * nx + ball.vy * ny;
      if (normalSpeed >= 0) return;
      const impulse = -(1 + (normalSpeed < -0.25 ? restitution : 0)) * normalSpeed * ball.mass;
      ball.vx += nx * impulse / ball.mass;
      ball.vy += ny * impulse / ball.mass;
      const tx = -ny;
      const ty = nx;
      const tangentSpeed = ball.vx * tx + ball.vy * ty - ball.angularVelocity * ball.radius;
      const tangentImpulse = clamp(-tangentSpeed * ball.mass / 3, -this.friction * impulse, this.friction * impulse);
      ball.vx += tx * tangentImpulse / ball.mass;
      ball.vy += ty * tangentImpulse / ball.mass;
      ball.angularVelocity -= tangentImpulse * 2 / (ball.mass * ball.radius);
      this._recordImpact(impulse, -normalSpeed);
    }

    _circleContact(ball, x, y, radius) {
      const dx = ball.x - x;
      const dy = ball.y - y;
      const distance = Math.hypot(dx, dy);
      const penetration = ball.radius + radius - distance;
      if (penetration <= 0) return;
      const nx = distance > 1e-9 ? dx / distance : 0;
      const ny = distance > 1e-9 ? dy / distance : -1;
      ball.x += nx * (penetration + 1e-7);
      ball.y += ny * (penetration + 1e-7);
      this._wallImpulse(ball, nx, ny);
    }

    _chamberContact(ball) {
      const distance = Math.hypot(ball.x, ball.y);
      const maximum = this.radius - ball.radius;
      const openingAtBall = this.gateOpen && ball.y > 0 &&
        Math.abs(ball.x / Math.max(distance, 1e-9)) < this.gateHalfWidth;
      if (distance > maximum && !openingAtBall) {
        const nx = -ball.x / distance;
        const ny = -ball.y / distance;
        ball.x += nx * (distance - maximum + 1e-7);
        ball.y += ny * (distance - maximum + 1e-7);
        this._wallImpulse(ball, nx, ny);
      }
      if (this.gateOpen) {
        this._circleContact(ball, -this.gateHalfWidth, this.gateY, 0.007);
        this._circleContact(ball, this.gateHalfWidth, this.gateY, 0.007);
        if (ball.y > this.gateY) this._tubeWalls(ball);
      }
    }

    _tubeWalls(ball) {
      const side = this.gateHalfWidth - ball.radius;
      if (ball.x < -side) {
        ball.x = -side;
        this._wallImpulse(ball, 1, 0, 0.30);
      } else if (ball.x > side) {
        ball.x = side;
        this._wallImpulse(ball, -1, 0, 0.30);
      }
      const floor = this.tubeBottom - ball.radius;
      if (ball.y > floor) {
        ball.y = floor;
        this._wallImpulse(ball, 0, -1, 0.16);
        if (Math.abs(ball.vy) < 0.08) ball.vy = 0;
      }
    }

    _ballContact(a, b) {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.hypot(dx, dy);
      const penetration = a.radius + b.radius - distance;
      if (penetration <= 0) return;
      const nx = distance > 1e-9 ? dx / distance : 1;
      const ny = distance > 1e-9 ? dy / distance : 0;
      const inverseA = 1 / a.mass;
      const inverseB = 1 / b.mass;
      const correction = (penetration + 1e-7) / (inverseA + inverseB) * 0.8;
      a.x -= nx * correction * inverseA;
      a.y -= ny * correction * inverseA;
      b.x += nx * correction * inverseB;
      b.y += ny * correction * inverseB;
      const normalSpeed = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
      if (normalSpeed >= 0) return;
      const restitution = normalSpeed < -0.25 ? this.restitution : 0;
      const impulse = -(1 + restitution) * normalSpeed / (inverseA + inverseB);
      a.vx -= nx * impulse * inverseA;
      a.vy -= ny * impulse * inverseA;
      b.vx += nx * impulse * inverseB;
      b.vy += ny * impulse * inverseB;
      const tx = -ny;
      const ty = nx;
      const tangentialSpeed = (b.vx - a.vx) * tx + (b.vy - a.vy) * ty -
        a.angularVelocity * a.radius - b.angularVelocity * b.radius;
      const tangentImpulse = clamp(-tangentialSpeed / (3 * (inverseA + inverseB)),
        -this.friction * impulse, this.friction * impulse);
      a.vx -= tx * tangentImpulse * inverseA;
      a.vy -= ty * tangentImpulse * inverseA;
      b.vx += tx * tangentImpulse * inverseB;
      b.vy += ty * tangentImpulse * inverseB;
      a.angularVelocity -= tangentImpulse * 2 / (a.mass * a.radius);
      b.angularVelocity -= tangentImpulse * 2 / (b.mass * b.radius);
      this._recordImpact(impulse, -normalSpeed);
    }

    _rotorContact(ball, segments) {
      for (const segment of segments) {
        const dx = segment.b.x;
        const dy = segment.b.y;
        const t = clamp((ball.x * dx + ball.y * dy) / this.rotorRadius ** 2, 0, 1);
        const point = { x: dx * t, y: dy * t };
        const rx = ball.x - point.x;
        const ry = ball.y - point.y;
        const distance = Math.hypot(rx, ry);
        const penetration = ball.radius + segment.radius - distance;
        if (penetration <= 0) continue;
        const nx = distance > 1e-9 ? rx / distance : -Math.sin(this.rotorAngle);
        const ny = distance > 1e-9 ? ry / distance : Math.cos(this.rotorAngle);
        ball.x += nx * (penetration + 1e-7);
        ball.y += ny * (penetration + 1e-7);
        const normalSpeed = (ball.vx + point.y * this.rotorVelocity) * nx +
          (ball.vy - point.x * this.rotorVelocity) * ny;
        if (normalSpeed >= 0) continue;
        const arm = cross(point, { x: nx, y: ny });
        const denominator = 1 / ball.mass + arm ** 2 / this.rotorInertia;
        const impulse = -(1 + (normalSpeed < -0.25 ? 0.50 : 0)) * normalSpeed / denominator;
        ball.vx += nx * impulse / ball.mass;
        ball.vy += ny * impulse / ball.mass;
        this.rotorVelocity -= arm * impulse / this.rotorInertia;
        this._recordImpact(impulse, -normalSpeed);
      }
      this._circleContact(ball, 0, 0, this.rotorHubRadius);
    }

    _advance(h) {
      this.elapsed += h;
      if (!this.captured && this.elapsed >= this.mixingDuration) this.gateOpen = true;
      if (this.elapsed < this.mixingDuration) {
        const target = this._driveVelocity * Math.exp(-0.045 * this.elapsed);
        this.rotorVelocity += clamp((target - this.rotorVelocity) * 14, -85, 85) * h;
      } else {
        const speed = Math.max(0, (Math.abs(this.rotorVelocity) + 0.06 / 0.50) *
          Math.exp(-0.50 * h) - 0.06 / 0.50);
        this.rotorVelocity = speed === 0 ? 0 : Math.sign(this.rotorVelocity) * speed;
      }
      this.rotorAngle += this.rotorVelocity * h;
      const segments = this.getRotorSegments();
      const previousPositions = [];
      for (const ball of this.balls) {
        previousPositions[ball.number] = { x: ball.x, y: ball.y };
        let ax = 0;
        let ay = this.gravity;
        if (!ball.captured && this.elapsed >= this.mixingDuration) {
          const t = this.elapsed - this.mixingDuration;
          // Keep the physical anti-bridging jet running until a disk clears
          // the sensor, then let the blower pressure decay naturally.
          const nozzle = this.captured ? Math.exp(-0.65 * (this.elapsed - this.captureEvent.time)) : 1;
          const lower = clamp((ball.y + 0.15) / 0.85, 0, 1);
          ax += lower * (-ball.x * 19 + 5.5 * Math.sin(t * 7 + ball.y * 2)) * nozzle;
          ay += lower * (4.0 + 14.0 * Math.sin(t * 8 + ball.x * 3)) * nozzle;
        }
        ball.vx += ax * h;
        ball.vy += ay * h;
        const drag = ball.captured ? 1.4 : this.elapsed >= this.mixingDuration
          ? 0.65 + this.friction * 0.20 : 0.09 + this.friction * 0.10;
        ball.vx *= Math.exp(-drag * h);
        ball.vy *= Math.exp(-drag * h);
        ball.angularVelocity *= Math.exp(-0.7 * h);
        ball.x += ball.vx * h;
        ball.y += ball.vy * h;
        ball.angle += ball.angularVelocity * h;
      }

      for (let iteration = 0; iteration < 7; iteration++) {
        for (let i = 0; i < this.balls.length; i++) {
          const a = this.balls[i];
          if (a.captured) {
            this._tubeWalls(a);
            continue;
          }
          this._chamberContact(a);
          this._rotorContact(a, segments);
          for (let j = i + 1; j < this.balls.length; j++) {
            const b = this.balls[j];
            if (!b.captured) this._ballContact(a, b);
          }
        }
      }
      // A pair correction can push a neighbour against the wall at the end
      // of an iteration. Finish with the boundary constraints so a closed
      // drum is always an exact containment boundary.
      for (const ball of this.balls) {
        if (ball.captured) this._tubeWalls(ball);
        else this._chamberContact(ball);
      }
      // The earliest actual threshold crossing determines the output ball.
      if (this.gateOpen && !this.captured) {
        let candidate = null;
        let fraction = Infinity;
        for (const ball of this.balls) {
          const before = previousPositions[ball.number];
          if (before.y < this.captureLine && ball.y >= this.captureLine && ball.vy > 0 &&
              Math.abs(ball.x) <= this.gateHalfWidth - ball.radius + 1e-6) {
            const crossing = (this.captureLine - before.y) / (ball.y - before.y);
            if (crossing < fraction) {
              candidate = ball;
              fraction = crossing;
            }
          }
        }
        if (candidate) {
          this.captured = candidate;
          candidate.captured = true;
          this.gateOpen = false;
          this.captureEvent = {
            number: candidate.number, previous: previousPositions[candidate.number],
            x: candidate.x, y: candidate.y, time: this.elapsed - h + fraction * h
          };
        }
      }

      if (this.captured) {
        const ball = this.captured;
        const capturedAtRest = Math.abs(ball.y - (this.tubeBottom - ball.radius)) < 0.001 &&
          Math.hypot(ball.vx, ball.vy) < 0.10;
        let maximumOtherSpeed = 0;
        for (const other of this.balls) {
          if (!other.captured) maximumOtherSpeed = Math.max(maximumOtherSpeed, Math.hypot(other.vx, other.vy));
        }
        if (capturedAtRest && Math.abs(this.rotorVelocity) < 0.12 && maximumOtherSpeed < 0.25) {
          this._restTime += h;
        } else {
          this._restTime = 0;
        }
        if (this._restTime >= 0.40) {
          ball.vx = 0;
          ball.vy = 0;
          this.settled = true;
        }
      }
    }
  }

  /** A single pool, drawing multiple actual balls without replacing them. */
  class SeriesBallDrumPhysics extends BallDrumPhysics {
    constructor({ drawCount, ...options } = {}) {
      super(options);
      if (!Number.isInteger(drawCount) || drawCount < 1 || drawCount > this.count) {
        throw new RangeError('drawCount must be between one and the number of balls');
      }
      this.drawCount = drawCount;
    }

    reset() {
      super.reset();
      this.mixingDuration = 6.25;
      this.drawnNumbers = [];
      this.captureEvents = [];
      this.collectedBalls = [];
      this.seriesElapsed = 0;
      this._capturedRestTime = 0;
      this._recordedBall = null;
      return this;
    }

    _advance(h) {
      this.seriesElapsed += h;
      super._advance(h);
      if (!this.captured) return;
      if (this._recordedBall !== this.captured) {
        this._recordedBall = this.captured;
        this.drawnNumbers.push(this.captured.number);
        this.captureEvents.push({ ...this.captureEvent,
          time: this.seriesElapsed - this.elapsed + this.captureEvent.time });
      }
      if (this.drawnNumbers.length >= this.drawCount) return;
      const ball = this.captured;
      const atRest = Math.abs(ball.y - (this.tubeBottom - ball.radius)) < 0.001 &&
        Math.hypot(ball.vx, ball.vy) < 0.10;
      this._capturedRestTime = atRest ? this._capturedRestTime + h : 0;
      if (this._capturedRestTime < 0.20) return;

      // Move the actual discharged ball into the receiver rack. Remaining
      // balls retain their physical positions, velocities and identities.
      this.collectedBalls.push(ball);
      this.balls = this.balls.filter((other) => other !== ball);
      this.captured = null;
      this.captureEvent = null;
      this._recordedBall = null;
      this.gateOpen = false;
      this.settled = false;
      this.elapsed = 0;
      this._restTime = 0;
      this._capturedRestTime = 0;
      this.lastImpact = -Infinity;
      this.mixingDuration = 1.75;
    }
  }

  return { BallDrumPhysics, SeriesBallDrumPhysics, TAU, FIXED_STEP };
});
