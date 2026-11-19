import type {ConsoleSeat,ConsoleConfiguration,ConsoleSettings,ConsoleProvider} from '../../../contracts/src/index.js';
import type {AgentSeatConfig} from '../controller/contracts/agent-config.js';
/** The local HTTP console depends on capabilities, not AgentRuntime's class. */
export interface ConsoleService {
 readonly fixedController:boolean;
 validatePluginConnection?(id:string):Promise<{name:string;passed:boolean;message?:string}[]>;
 readonly modelQueue?:{readonly status:unknown};
 status():ConsoleSeat[];
 consoleConfig():ConsoleConfiguration;
 browserIdentity?(id:string):{serverUrl:string;roomId:string;playerToken:string;code?:string};
 tickTimes?(id:string,after:number):Promise<import('../../../contracts/src/index.js').TickTimePage|null>;
 consoleLogs(id:string,before?:number):unknown;
 updateSettings(id:string,raw:unknown):ConsoleSettings;
 configureProvider(id:string,raw:unknown):ConsoleProvider;
 configureSeat(id:string,provider:unknown,settings:unknown):{settings:ConsoleSettings;providerConfig:ConsoleProvider};
 listProviderModels(id:string,config?:unknown):Promise<{models:string[]}>;
 start(id:string):Promise<void>;
 pause(id:string):Promise<void>;
 addSeat(config:AgentSeatConfig,token:string):unknown;
 removeSeat(id:string):void;
 bindControllerSlot?(slot:number,config:AgentSeatConfig,token:string):Promise<void>;
 debugRead(id:string,section:string,query?:Record<string,string>):unknown;
 debugStatus(id:string):unknown;
 clearDiagnostics(id:string):unknown;
 setDebug(id:string,raw:unknown):unknown;
 resumeDebug(id:string,breakpointId:string):Promise<unknown>;
 discardDebug(id:string,breakpointId:string):Promise<unknown>;
}
