import * as Croquet from "@croquet/croquet";
import {
  AnimationMixer,
  Box3,
  Clock,
  Object3D,
  Quaternion,
  Scene,
  Vector3,
  WebGLCubeRenderTarget,
  UnsignedByteType,
  sRGBEncoding,
  AmbientLight,
  MeshBasicMaterial,
  TextureLoader,
  PlaneGeometry,
  Mesh,
  DoubleSide,
} from "three";
import { RGBELoader } from "three/examples/jsm/loaders/RGBELoader";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader";
import MultiAppManager, { PMALAppMessageEventType, AssetType } from "@plutovr/multi-app-manager";
import { loadScene } from "../engine/engine";
import XRInput from "../engine/xrinput";
import Renderer from "../engine/renderer";
import State from "../engine/state";
import { SCRaycaster } from "../engine/util/webxr/raycaster";

const Q = Croquet.Constants;

const MIN_SIZE = 0.1;
const HANDEDNESS = {
  left: "left",
  right: "right",
};
const PUSHPULL_VELOCITY_MULTIPLIER = 0.001;
const HDR_ENVIRONMENT_IMAGE = require("../assets/hdr/studio003.hdr");
const DEFAULT_MODEL_URL = "../assets/models/defaultmodel.glb";

export default class View extends Croquet.View {
  constructor(model) {
    super(model);

    State.debugMode = false;
    State.isLeftTriggerPressed = false;
    State.isRightTriggerPressed = false;

    this.croquetModel = model;

    this.assetMesh = undefined;
    this.isLeftColliding = false;
    this.isRightColliding = false;
    this.holdingAssetWithHand = undefined;
    this.holdingWithHandToTogglePin = undefined;

    this.animationMixer = null;
    this.scene = new Scene();
    this.clock = new Clock();
    const aLight = new AmbientLight(0xffffff, 1);
    this.scene.add(aLight);

    Renderer.outputEncoding = sRGBEncoding;
    loadScene(this.scene);

    this.loadAsset();

    this.subscribe(Q.SCOPE_VIEW, Q.EVENT_PICKUP, this.pickup);
    this.subscribe(Q.SCOPE_VIEW, Q.EVENT_MOVE, this.move);
    this.subscribe(Q.SCOPE_VIEW, Q.EVENT_DROP, this.drop);
    this.subscribe(Q.SCOPE_VIEW, Q.EVENT_SCALE, this.scale);
    this.subscribe(Q.SCOPE_VIEW, Q.EVENT_TOGGLE_PIN, this.togglePin);
  }

  loadAsset() {
    const assetData = MultiAppManager.getAppState().assetLoader;
    const assetUrl = assetData && assetData.url ? assetData.url : DEFAULT_MODEL_URL;
    const isStatic = assetData && assetData.isStatic;
    const isUrlImage = assetData && assetData.assetType === AssetType.image;

    this.getCubeMapTexture(HDR_ENVIRONMENT_IMAGE).then(({ envMap }) => {
      this.scene.environment = envMap;

      let loader = isUrlImage ? new TextureLoader() : new GLTFLoader();
      loader.load(
        assetUrl,
        asset => {
          this.assetMesh = isUrlImage ? this.getMeshForTexture(asset) : asset.scene;

          this.placeAssetInScene();
          this.setPinStateAndEvents(assetData);
          if (!isUrlImage) {
            this.setupAnimation(asset);
          }
          if (!isStatic) {
            this.createAssetCollider();
            this.setupInputSources();
            this.setupRaycasting();
            this.setupInputEventHandlers();
          }

          MultiAppManager.onProvideTransform = () => {
            let { position, quaternion, scale } = this.croquetModel.transform;
            // THREE.Quaternion uses getters for properties, which results in underscores ("_x", "_y", "_z", "_w")
            return {
              position,
              quaternion: { x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w },
              scale,
            };
          };
        },
        undefined,
        error => {
          if (State.debugMode) {
            console.error(`An error happened while loading asset:`, error);
          }
        }
      );
    });
  }

  placeAssetInScene() {
    let initialTransform = this.getInitialTransform();

    if (initialTransform.position !== undefined) {
      this.assetMesh.position.copy(initialTransform.position);
    }

    if (initialTransform.quaternion !== undefined) {
      this.assetMesh.quaternion.copy(initialTransform.quaternion);
    }

    if (initialTransform.scale !== undefined) {
      let { x, y, z } = initialTransform.scale;
      this.assetMesh.scale.set(x, y, z);
    }

    this.scene.add(this.assetMesh);

    this.publish(Q.SCOPE_MODEL, Q.EVENT_MOVE, {
      position: this.assetMesh.position,
      quaternion: this.assetMesh.quaternion,
    });
    this.publish(Q.SCOPE_MODEL, Q.EVENT_SCALE, {
      viewId: this.viewId,
      scale: this.assetMesh.scale,
    });
  }

  setPinStateAndEvents(assetData) {
    const shouldStartAsPinned = !this.croquetModel.hasBeenPinned && !!assetData?.isPinned;
    if (shouldStartAsPinned) {
      this.pinAsset();
    } else {
      MultiAppManager.setPinState(this.croquetModel.isPinned);
    }

    // Respond to Pin events
    MultiAppManager.addEventListener(PMALAppMessageEventType.shouldPinApp, this.pinAsset);
    MultiAppManager.addEventListener(PMALAppMessageEventType.shouldUnpinApp, this.unpinAsset);
  }

  createAssetCollider() {
    this.assetCollider = new Box3();

    this.assetMesh.Update = () => {
      this.assetCollider.setFromObject(this.assetMesh);

      if (
        this.croquetModel.heldByViewId === this.viewId &&
        this.holdingAssetWithHand !== undefined
      ) {
        let _tp = new Vector3();
        let _tq = new Quaternion();
        this.assetMesh.getWorldPosition(_tp);
        this.assetMesh.getWorldQuaternion(_tq);
        this.publish(Q.SCOPE_MODEL, Q.EVENT_MOVE, {
          position: _tp,
          quaternion: _tq,
        });
      }
    };
  }

  // Inputs

  setupInputSources() {
    const inputHandler = new Object3D();
    this.scene.add(inputHandler);
    this.scene.add(XRInput.leftController);
    this.scene.add(XRInput.rightController);

    inputHandler.Update = () => {
      if (!XRInput.hasInputSources) return;

      let leftPosition = XRInput.leftController.position;
      let rightPosition = XRInput.rightController.position;

      this.isLeftColliding = leftPosition && this.assetCollider.containsPoint(leftPosition);
      this.isRightColliding = rightPosition && this.assetCollider.containsPoint(rightPosition);

      this.checkInputForScaling(this.holdingAssetWithHand);
      this.checkInputForForcePushPull(this.holdingAssetWithHand);
    };
  }

  setupRaycasting() {
    let leftController = Renderer.xr.getController(0);
    let rightController = Renderer.xr.getController(1);

    this.scene.add(leftController);
    this.scene.add(rightController);

    this.leftRaycaster = new SCRaycaster(leftController, this.assetCollider);
    this.rightRaycaster = new SCRaycaster(rightController, this.assetCollider);

    this.leftRaycaster.visualize(0xff00ff, true);
    this.rightRaycaster.visualize(0xff00ff, true);

    const Manager = new Object3D();
    Manager.Update = () => {
      // raycasting against a Box3 will return a bool
      this.leftRaycastResults = this.leftRaycaster.getIntersections();
      this.rightRaycastResults = this.rightRaycaster.getIntersections();
    };
    this.scene.add(Manager);
  }

  setupInputEventHandlers() {
    State.eventHandler.addEventListener("selectstart", e => {
      const handedness = this.correctHandedness(e.inputSource.handedness);
      State.isLeftTriggerPressed =
        handedness === HANDEDNESS.left ? true : State.isLeftTriggerPressed;
      State.isRightTriggerPressed =
        handedness === HANDEDNESS.right ? true : State.isRightTriggerPressed;

      if (this.croquetModel.isHeld || this.croquetModel.isPinned) return;

      // The handedness bug does not occur with raycasting, so only swap handedness for collisions
      const isInteractingWithAsset =
        this.hasRaycastResults(e.inputSource.handedness) || this.hasCollisionResults(handedness);

      if (isInteractingWithAsset) {
        this.publish(Q.SCOPE_MODEL, Q.EVENT_PICKUP, {
          viewId: this.viewId,
          handedness: handedness,
        });

        if (handedness === HANDEDNESS.left && this.assetMesh.parent !== XRInput.leftController) {
          XRInput.leftController.attach(this.assetMesh);
        } else if (
          handedness === HANDEDNESS.right &&
          this.assetMesh.parent !== XRInput.rightController
        ) {
          XRInput.rightController.attach(this.assetMesh);
        }
      }
    });

    State.eventHandler.addEventListener("selectend", e => {
      if (State.isScaling) State.isScaling = false;
      if (State.initialControllerDistance !== undefined) {
        State.initialControllerDistance = undefined;
      }
      if (this.croquetModel.isPinned) return;

      const handedness = this.correctHandedness(e.inputSource.handedness);
      State.isLeftTriggerPressed = handedness === "left" ? false : State.isLeftTriggerPressed;
      State.isRightTriggerPressed = handedness === "right" ? false : State.isRightTriggerPressed;

      // Drop the asset if it's being held
      if (
        this.croquetModel.heldByViewId === this.viewId &&
        handedness === this.holdingAssetWithHand
      ) {
        this.detachAndDropAsset();
      }
    });
  }

  setupAnimation(gltf) {
    if (gltf.animations.length === 0) return;

    this.animationMixer = new AnimationMixer(gltf.scene);
    const action = this.animationMixer.clipAction(gltf.animations[0]);
    action.play();

    this.animationManager = new Object3D();
    this.animationManager.name = "Animation Manager";
    this.animationManager.Update = () => {
      if (this.animationMixer && this.clock) {
        this.animationMixer.update(this.clock.getDelta());
      }
    };
    this.scene.add(this.animationManager);
  }

  // Model Events

  pickup(data) {
    if (data.viewId !== this.viewId) return;
    this.holdingAssetWithHand = data.handedness;
  }

  move() {
    if (this.assetMesh === undefined) return;
    if (this.croquetModel.isPinned || !this.croquetModel.isHeld) return;
    if (this.croquetModel.position && this.croquetModel.heldByViewId !== this.viewId) {
      this.assetMesh.position.copy(this.croquetModel.position);
      this.assetMesh.quaternion.copy(this.croquetModel.quaternion);
    }
  }

  drop(data) {
    if (data.viewId !== this.viewId) return;
    this.holdingAssetWithHand = undefined;
  }

  scale(data) {
    if (this.assetMesh === undefined) return;

    if (this.croquetModel.scale && data.viewId !== this.viewId) {
      let { x, y, z } = this.croquetModel.scale;
      this.assetMesh.scale.set(x, y, z);
    }
  }

  togglePin() {
    MultiAppManager.setPinState(this.croquetModel.isPinned);
  }

  // Helpers

  checkInputForScaling(handedness) {
    if (handedness === undefined) return;
    XRInput.inputSources.forEach(e => {
      let eHandedness = this.correctHandedness(e.handedness);

      if (eHandedness === handedness) {
        const otherHand = eHandedness === HANDEDNESS.left ? HANDEDNESS.right : HANDEDNESS.left;
        // if other hand is also raycasting at the object and both triggers pressed, pinch scale
        if (
          this.hasRaycastResults(otherHand) &&
          State.isLeftTriggerPressed &&
          State.isRightTriggerPressed
        ) {
          // separate state so that if controllers don't raycast during scale operation, scaling doesn't stop. Only selectEnd will stop it.
          State.isScaling = true;
          if (State.initialControllerDistance === undefined) {
            State.initialControllerDistance = XRInput.leftController.position.distanceTo(
              XRInput.rightController.position
            );
          }
        }

        if (State.isScaling) {
          const scalingDelta =
            XRInput.leftController.position.distanceTo(XRInput.rightController.position) -
            State.initialControllerDistance;
          let scale;
          if (scalingDelta > 0.05) {
            scale = this.scaleUp(scalingDelta / 10);
          } else if (scalingDelta < -0.05) {
            scale = this.scaleDown(Math.abs(scalingDelta) / 10);
          }
          if (scale) {
            this.publish(Q.SCOPE_MODEL, Q.EVENT_SCALE, {
              viewId: this.viewId,
              scale,
            });
          }
        }
      }
    });
  }

  checkInputForForcePushPull(handedness) {
    if (handedness === undefined) return;
    XRInput.inputSources.forEach(e => {
      let eHandedness = this.correctHandedness(e.handedness);
      if (eHandedness === handedness) {
        e.gamepad.axes.forEach((axis, axisIndex) => {
          if (axisIndex % 2 != 0 && Math.abs(axis) > 0.1) {
            // don't pull if too close to controller, don't push if too far away
            if (
              (this.assetMesh.position.z > -0.4 && axis > 0) ||
              (this.assetMesh.position.z < -25 && axis < 0)
            )
              return;

            // speed weights: joystick pressure & distance from controller to mesh
            const movementVelocity =
              PUSHPULL_VELOCITY_MULTIPLIER *
              axis *
              10 *
              Math.pow(Math.abs(this.assetMesh.position.z), 1.25);
            this.assetMesh.position.z += movementVelocity;
          }
        });
      }
    });
  }

  scaleUp(scalar = 0.025) {
    let { x } = this.assetMesh.scale;
    return this.assetMesh.scale.setScalar(x + scalar).clone();
  }

  scaleDown(scalar = 0.025) {
    let { x } = this.assetMesh.scale;
    let dx = x - scalar > MIN_SIZE ? x - scalar : MIN_SIZE;
    return this.assetMesh.scale.setScalar(dx).clone();
  }

  /** Bug fix / HACK:
   * XRPackage's implementation of XRInputSource expects the
   * left hand to be at index 0 and the right hand to be at index 1.
   * The real XRInputSource does not do this, and the Three implementation
   * of `getControllers` does not assume this either. This corrects that bug
   * and can be removed once it's fixed in XRPackage.
   * */
  correctHandedness(handedness) {
    if (!this.isInIframe() || XRInput.inputSources.length <= 1) return handedness;

    let firstHandedness = XRInput.inputSources[0].handedness;
    let secondHandedness = XRInput.inputSources[1].handedness;
    let isHandednessSwapped =
      firstHandedness == HANDEDNESS.right && secondHandedness == HANDEDNESS.left;

    let retVal;
    if (isHandednessSwapped) {
      retVal = handedness == HANDEDNESS.right ? HANDEDNESS.left : HANDEDNESS.right;
    } else {
      retVal = handedness;
    }

    return retVal;
  }

  isInIframe() {
    try {
      return window.self !== window.top;
    } catch (e) {
      return true;
    }
  }

  pinAsset = () => {
    if (this.croquetModel.isHeld) {
      console.info(
        "Asset is currently held, cannot pin app " + MultiAppManager.getAppState().appId
      );
      return;
    }

    this.detachAndDropAsset();
    this.publish(Q.SCOPE_MODEL, Q.EVENT_TOGGLE_PIN, { viewId: this.viewId });
    MultiAppManager.didPinApp(this.croquetModel.transform);
  };

  unpinAsset = () => {
    this.publish(Q.SCOPE_MODEL, Q.EVENT_TOGGLE_PIN, { viewId: this.viewId });
    MultiAppManager.didUnpinApp();
  };

  detachAndDropAsset() {
    this.scene.attach(this.assetMesh);
    this.publish(Q.SCOPE_MODEL, Q.EVENT_DROP, {
      viewId: this.viewId,
    });
  }

  hasRaycastResults(handedness) {
    return handedness === HANDEDNESS.left ? !!this.leftRaycastResults : !!this.rightRaycastResults;
  }

  hasCollisionResults(handedness) {
    return handedness === HANDEDNESS.left ? this.isLeftColliding : this.isRightColliding;
  }

  getCubeMapTexture(environment) {
    return new Promise((resolve, reject) => {
      const loader = new RGBELoader().setDataType(UnsignedByteType);
      loader.load(
        environment,
        texture => {
          const cubeRenderTarget = new WebGLCubeRenderTarget(1024).fromEquirectangularTexture(
            Renderer,
            texture
          );
          const envMap = cubeRenderTarget.texture;
          resolve({ envMap });
        },
        undefined,
        reject
      );
    });
  }

  getMeshForTexture(texture) {
    let w = texture.image.width;
    let h = texture.image.height;

    let geoWidth, geoHeight;
    if (w === h) {
      geoWidth = 3;
      geoHeight = 3;
    } else if (w > h) {
      geoWidth = 3 * (w / h);
      geoHeight = 3;
    } else if (h > w) {
      geoWidth = 3;
      geoHeight = 3 * (h / w);
    }

    const material = new MeshBasicMaterial({
      map: texture,
      side: DoubleSide,
    });
    let geometry = new PlaneGeometry(geoWidth, geoHeight, 5, 5);
    return new Mesh(geometry, material);
  }

  getInitialTransform() {
    if (this.croquetModel.hasTransform) {
      return this.croquetModel.transform;
    }

    let initialTransform = MultiAppManager.getAppState().initialTransform;
    let initialPosition = MultiAppManager.getAppState().initialPosition;

    if (initialTransform !== undefined) {
      let { position, quaternion, scale } = initialTransform;
      return {
        position: new Vector3(position.x, position.y, position.z),
        quaternion: new Quaternion(quaternion.x, quaternion.y, quaternion.z, quaternion.w),
        scale: new Vector3(scale.x, scale.y, scale.z),
      };
    } else if (initialPosition !== undefined) {
      return {
        position: new Vector3(initialPosition.x, initialPosition.y, initialPosition.z),
        quaternion: undefined,
        scale: undefined,
      };
    } else {
      return {
        position: new Vector3(0, 0, 0),
        quaternion: undefined,
        scale: undefined,
      };
    }
  }
}
