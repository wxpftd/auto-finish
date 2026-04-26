/**
 * Event bus + WebSocket transport.
 *
 * Pipeline events flow:
 *   pipeline orchestrator -> EventBus.publish(BusMessage) ->
 *     in-process subscribers (e.g. persistence) AND
 *     WebSocket server -> dashboard clients
 */

export type { BusMessage, AsyncIterableOpts } from './bus.js';
export { EventBus, topicMatches } from './bus.js';

export type { WsServerOpts, WsServerHandle } from './websocket-server.js';
export {
  startWebSocketServer,
  AUTH_REJECTED_CLOSE_CODE,
} from './websocket-server.js';
