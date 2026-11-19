import type {AiSettings} from '@subterfuge/bot-sdk/contracts/types';

/** A configured model is optional; missing configuration is not a model failure. */
export function hybridHasModel(settings:Readonly<AiSettings>):boolean {
  return settings.model.trim().length>0&&settings.provider!=='offline';
}
