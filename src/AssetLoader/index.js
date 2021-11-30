import * as Croquet from "@croquet/croquet";
import MultiAppManager from "@plutovr/multi-app-manager";
import { v4 as uuidv4 } from "uuid";
import View from "./View";
import Model from "./Model";

// ENTER YOUR OWN CROQUET API KEY, APP ID AND PASSWORD HERE

const CROQUET_API_KEY = "[YOUR-API-KEY-HERE]";
const APP_ID = "[YOUR-APP-ID-HERE]";
const PASSWORD = "[YOUR-PASSWORD-HERE]";

const Q = Croquet.Constants;
Q.SCOPE_MODEL = "model";
Q.SCOPE_VIEW = "view";
Q.EVENT_PICKUP = "event_pickup";
Q.EVENT_DROP = "event_drop";
Q.EVENT_MOVE = "event_move";
Q.EVENT_SCALE = "event_scale";
Q.EVENT_TOGGLE_PIN = "event_toggle_pin";

const AssetLoader = () => {
  Model.register("AssetLoaderModel");

  const xrpkAppId = MultiAppManager.getAppState().appId;
  const name = xrpkAppId ? xrpkAppId : "asset-loader-" + uuidv4();

  Croquet.Session.join({
    apiKey: CROQUET_API_KEY,
    APP_ID,
    name,
    PASSWORD,
    model: Model,
    view: View,
    autoSleep: false,
  });
};

export default AssetLoader;
