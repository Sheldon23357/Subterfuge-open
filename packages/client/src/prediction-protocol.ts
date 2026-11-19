import type { PlayerObservation, PlayerForecastResponse } from '../../contracts/src/index.js';
import type {KnownPredictionDraft,KnownDeploymentPreview} from '../../prediction/src/index.js';
export type LocalDeploymentResult=KnownDeploymentPreview&{roomId:string;revision:string};
export type PredictionRequest = { kind: 'predict'; id: number; targetTick: number; observation?: PlayerObservation } | {kind:'deploy';id:number;observation:PlayerObservation;draft:KnownPredictionDraft} | { kind: 'cancel'; id: number };
export type PredictionReply = { id: number; response: PlayerForecastResponse } | {id:number;deployment:LocalDeploymentResult} | { id: number; error: string };
