import {LabAi as ApplicationLabAi} from '../../packages/server/src/lab-ai.js';
import {SeatRunner} from './scripted-controller.js';
/** Only the instruction source is scripted; HTTP, leases, storage and room
 * stepping still execute the product controller and server implementation. */
export class LabAi extends ApplicationLabAi{
 constructor(...args:ConstructorParameters<typeof ApplicationLabAi>){const [host,store,provider]=args;super(host,store,provider,SeatRunner);}
}
