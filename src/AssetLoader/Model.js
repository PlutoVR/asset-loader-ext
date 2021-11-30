import * as Croquet from "@croquet/croquet";
import { Quaternion, Vector3 } from "three";

const Q = Croquet.Constants;

class Model extends Croquet.Model {
  static types() {
    return {
      Vector3: Vector3,
      Quaternion: {
        cls: Quaternion,
        write: quaternion => ({
          x: quaternion.x,
          y: quaternion.y,
          z: quaternion.z,
          w: quaternion.w,
        }),
        read: state => new Quaternion(state.x, state.y, state.z, state.w),
      },
    };
  }

  init(options) {
    super.init(options);

    this.position = undefined;
    this.quaternion = undefined;
    this.scale = undefined;
    this.heldByViewId = undefined;
    this._pinned = false;
    this.hasBeenPinned = false;
    this.pinnedByViewId = undefined;

    // Subscribe to view events
    this.subscribe(Q.SCOPE_MODEL, Q.EVENT_PICKUP, this.Pickup);
    this.subscribe(Q.SCOPE_MODEL, Q.EVENT_MOVE, this.Move);
    this.subscribe(Q.SCOPE_MODEL, Q.EVENT_DROP, this.Drop);
    this.subscribe(Q.SCOPE_MODEL, Q.EVENT_SCALE, this.Scale);
    this.subscribe(Q.SCOPE_MODEL, Q.EVENT_TOGGLE_PIN, this.TogglePin);
  }

  get isHeld() {
    return this.heldByViewId !== undefined;
  }

  set isPinned(pinned) {
    this._pinned = pinned;
    if (!this.hasBeenPinned) this.hasBeenPinned = true;
  }

  get isPinned() {
    return this._pinned;
  }

  get hasTransform() {
    return this.position !== undefined && this.quaternion !== undefined && this.scale !== undefined;
  }

  get transform() {
    return {
      position: this.position,
      quaternion: this.quaternion,
      scale: this.scale,
    };
  }

  Pickup(data) {
    if (this.heldByViewId) return;

    this.heldByViewId = data.viewId;
    this.publish(Q.SCOPE_VIEW, Q.EVENT_PICKUP, data);
  }

  Move(data) {
    this.position = data.position;
    this.quaternion = data.quaternion;
    this.publish(Q.SCOPE_VIEW, Q.EVENT_MOVE);
  }

  Drop(data) {
    if (this.heldByViewId === undefined) return;

    this.heldByViewId = undefined;
    this.publish(Q.SCOPE_VIEW, Q.EVENT_DROP, data);
  }

  Scale(data) {
    if (this.scale && this.scale.equals(data.scale)) return;
    this.scale = data.scale;
    this.publish(Q.SCOPE_VIEW, Q.EVENT_SCALE, data);
  }

  TogglePin(data) {
    this.isPinned = !this.isPinned;
    this.pinnedByViewId = this.isPinned ? data.viewId : undefined;
    this.publish(Q.SCOPE_VIEW, Q.EVENT_TOGGLE_PIN);
  }
}

export default Model;
