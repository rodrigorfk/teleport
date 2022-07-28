// Copyright 2021 Gravitational, Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
import Logger from 'shared/libs/logger';

import { TermEventEnum } from 'teleport/lib/term/enums.js';
import { EventEmitterWebAuthnSender } from 'teleport/lib/EventEmitterWebAuthnSender';
import { WebauthnAssertionResponse } from 'teleport/services/auth';

import Codec, {
  MessageType,
  MouseButton,
  ButtonState,
  ScrollAxis,
  ClientScreenSpec,
  PngFrame,
  ClipboardData,
  FileType,
  SharedDirectoryErrCode,
  SharedDirectoryInfoResponse,
  SharedDirectoryListResponse,
  SharedDirectoryReadResponse,
  FileSystemObject,
} from './codec';
import {
  PathDoesNotExistError,
  SharedDirectoryManager,
  FileOrDirInfo,
} from './sharedDirectoryManager';

export enum TdpClientEvent {
  TDP_CLIENT_SCREEN_SPEC = 'tdp client screen spec',
  TDP_PNG_FRAME = 'tdp png frame',
  TDP_CLIPBOARD_DATA = 'tdp clipboard data',
  TDP_ERROR = 'tdp error',
  WS_OPEN = 'ws open',
  WS_CLOSE = 'ws close',
}

// Client is the TDP client. It is responsible for connecting to a websocket serving the tdp server,
// sending client commands, and recieving and processing server messages. It's listener is responsible for
// calling Client.nuke() (typically after Client emits a TdpClientEvent.DISCONNECT or TdpClientEvent.ERROR event) in order to clean
// up its websocket listeners.
export default class Client extends EventEmitterWebAuthnSender {
  protected codec: Codec;
  protected socket: WebSocket | undefined;
  private socketAddr: string;
  private sdManager: SharedDirectoryManager;

  private logger = Logger.create('TDPClient');

  constructor(socketAddr: string) {
    super();
    this.socketAddr = socketAddr;
    this.codec = new Codec();
    this.sdManager = new SharedDirectoryManager();
  }

  // Connect to the websocket and register websocket event handlers.
  init() {
    this.socket = new WebSocket(this.socketAddr);
    this.socket.binaryType = 'arraybuffer';

    this.socket.onopen = () => {
      this.logger.info('websocket is open');
      this.emit(TdpClientEvent.WS_OPEN);
    };

    this.socket.onmessage = (ev: MessageEvent) => {
      this.processMessage(ev.data as ArrayBuffer);
    };

    // The socket 'error' event will only ever be emitted by the socket
    // prior to a socket 'close' event (https://stackoverflow.com/a/40084550/6277051).
    // Therefore, we can rely on our onclose handler to account for any websocket errors.
    this.socket.onerror = null;
    this.socket.onclose = () => {
      this.logger.info('websocket is closed');

      // Clean up all of our socket's listeners and the socket itself.
      this.socket.onopen = null;
      this.socket.onmessage = null;
      this.socket.onclose = null;
      this.socket = null;

      this.emit(TdpClientEvent.WS_CLOSE);
    };
  }

  processMessage(buffer: ArrayBuffer) {
    try {
      const messageType = this.codec.decodeMessageType(buffer);
      switch (messageType) {
        case MessageType.PNG_FRAME:
          this.handlePngFrame(buffer);
          break;
        case MessageType.CLIENT_SCREEN_SPEC:
          this.handleClientScreenSpec(buffer);
          break;
        case MessageType.MOUSE_BUTTON:
          this.handleMouseButton(buffer);
          break;
        case MessageType.MOUSE_MOVE:
          this.handleMouseMove(buffer);
          break;
        case MessageType.CLIPBOARD_DATA:
          this.handleClipboardData(buffer);
          break;
        case MessageType.ERROR:
          this.handleError(new Error(this.codec.decodeErrorMessage(buffer)));
          break;
        case MessageType.MFA_JSON:
          this.handleMfaChallenge(buffer);
          break;
        case MessageType.SHARED_DIRECTORY_ACKNOWLEDGE:
          this.handleSharedDirectoryAcknowledge(buffer);
          break;
        case MessageType.SHARED_DIRECTORY_INFO_REQUEST:
          this.handleSharedDirectoryInfoRequest(buffer);
          break;
        case MessageType.SHARED_DIRECTORY_READ_REQUEST:
          this.handleSharedDirectoryReadRequest(buffer);
          break;
        case MessageType.SHARED_DIRECTORY_WRITE_REQUEST:
          this.handleSharedDirectoryWriteRequest(buffer);
          break;
        case MessageType.SHARED_DIRECTORY_LIST_REQUEST:
          this.handleSharedDirectoryListRequest(buffer);
          break;
        default:
          this.logger.warn(`received unsupported message type ${messageType}`);
      }
    } catch (err) {
      this.handleError(err);
    }
  }

  handleClientScreenSpec(buffer: ArrayBuffer) {
    this.logger.warn(
      `received unsupported message type ${this.codec.decodeMessageType(
        buffer
      )}`
    );
  }

  handleMouseButton(buffer: ArrayBuffer) {
    this.logger.warn(
      `received unsupported message type ${this.codec.decodeMessageType(
        buffer
      )}`
    );
  }

  handleMouseMove(buffer: ArrayBuffer) {
    this.logger.warn(
      `received unsupported message type ${this.codec.decodeMessageType(
        buffer
      )}`
    );
  }

  handleClipboardData(buffer: ArrayBuffer) {
    this.emit(
      TdpClientEvent.TDP_CLIPBOARD_DATA,
      this.codec.decodeClipboardData(buffer)
    );
  }

  // Assuming we have a message of type PNG_FRAME, extract its
  // bounds and png bitmap and emit a render event.
  handlePngFrame(buffer: ArrayBuffer) {
    this.codec.decodePngFrame(buffer, (pngFrame: PngFrame) =>
      this.emit(TdpClientEvent.TDP_PNG_FRAME, pngFrame)
    );
  }

  // TODO(isaiah): neither of the TdpClientEvent.TDP_ERROR are accurate, they should
  // instead be associated with a new event TdpClientEvent.CLIENT_ERROR.
  // https://github.com/gravitational/webapps/issues/615
  handleMfaChallenge(buffer: ArrayBuffer) {
    try {
      const mfaJson = this.codec.decodeMfaJson(buffer);
      if (mfaJson.mfaType == 'n') {
        this.emit(TermEventEnum.WEBAUTHN_CHALLENGE, mfaJson.jsonString);
      } else {
        // mfaJson.mfaType === 'u', or else decodeMfaJson would have thrown an error.
        this.handleError(
          new Error(
            'Multifactor authentication is required for accessing this desktop, \
      however the U2F API for hardware keys is not supported for desktop sessions. \
      Please notify your system administrator to update cluster settings \
      to use WebAuthn as the second factor protocol.'
          )
        );
      }
    } catch (err) {
      this.handleError(err);
    }
  }

  private wasSuccessful(errCode: SharedDirectoryErrCode) {
    if (errCode === SharedDirectoryErrCode.Nil) {
      return true;
    }

    this.handleError(
      new Error(`Encountered shared directory error: ${errCode}`)
    );
    return false;
  }

  handleSharedDirectoryAcknowledge(buffer: ArrayBuffer) {
    const ack = this.codec.decodeSharedDirectoryAcknowledge(buffer);

    if (!this.wasSuccessful(ack.errCode)) {
      return;
    }

    this.logger.info('Started sharing directory: ' + this.sdManager.getName());
  }

  async handleSharedDirectoryInfoRequest(buffer: ArrayBuffer) {
    const req = this.codec.decodeSharedDirectoryInfoRequest(buffer);
    const path = req.path;
    try {
      const info = await this.sdManager.getInfo(path);
      this.sendSharedDirectoryInfoResponse({
        completionId: req.completionId,
        errCode: SharedDirectoryErrCode.Nil,
        fso: this.toFso(info),
      });
    } catch (e) {
      if (e.constructor === PathDoesNotExistError) {
        this.sendSharedDirectoryInfoResponse({
          completionId: req.completionId,
          errCode: SharedDirectoryErrCode.DoesNotExist,
          fso: {
            lastModified: BigInt(0),
            fileType: FileType.File,
            size: BigInt(0),
            path: path,
          },
        });
      } else {
        this.handleError(e);
      }
    }
  }

  async handleSharedDirectoryReadRequest(buffer: ArrayBuffer) {
    const req = this.codec.decodeSharedDirectoryReadRequest(buffer);
    try {
      const readData = await this.sdManager.readFile(
        req.path,
        req.offset,
        req.length
      );
      this.sendSharedDirectoryReadResponse({
        completionId: req.completionId,
        errCode: SharedDirectoryErrCode.Nil,
        readDataLength: readData.length,
        readData,
      });
    } catch (e) {
      this.handleError(e);
    }
  }

  handleSharedDirectoryWriteRequest(buffer: ArrayBuffer) {
    const req = this.codec.decodeSharedDirectoryWriteRequest(buffer);
    // TODO(isaiah): delete debug logs
    this.logger.debug('Received SharedDirectoryWriteRequest:');
    this.logger.debug(req);
    // TODO(isaiah): here's where we'll respond with a SharedDirectoryWriteResponse
  }

  async handleSharedDirectoryListRequest(buffer: ArrayBuffer) {
    try {
      const req = this.codec.decodeSharedDirectoryListRequest(buffer);
      const path = req.path;

      const infoList: FileOrDirInfo[] = await this.sdManager.listContents(path);
      const fsoList: FileSystemObject[] = infoList.map(info =>
        this.toFso(info)
      );

      this.sendSharedDirectoryListResponse({
        completionId: req.completionId,
        errCode: SharedDirectoryErrCode.Nil,
        fsoList,
      });
    } catch (e) {
      this.handleError(e);
    }
  }

  private toFso(info: FileOrDirInfo): FileSystemObject {
    return {
      lastModified: BigInt(info.lastModified),
      fileType: info.kind === 'file' ? FileType.File : FileType.Directory,
      size: BigInt(info.size),
      path: info.path,
    };
  }

  protected send(
    data: string | ArrayBufferLike | Blob | ArrayBufferView
  ): void {
    if (this.socket && this.socket.readyState === 1) {
      try {
        this.socket.send(data);
      } catch (e) {
        this.handleError(e);
      }
      return;
    }

    this.handleError(new Error('websocket unavailable'));
  }

  sendUsername(username: string) {
    this.send(this.codec.encodeUsername(username));
  }

  sendMouseMove(x: number, y: number) {
    this.send(this.codec.encodeMouseMove(x, y));
  }

  sendMouseButton(button: MouseButton, state: ButtonState) {
    this.send(this.codec.encodeMouseButton(button, state));
  }

  sendMouseWheelScroll(axis: ScrollAxis, delta: number) {
    this.send(this.codec.encodeMouseWheelScroll(axis, delta));
  }

  sendKeyboardInput(code: string, state: ButtonState) {
    // Only send message if key is recognized, otherwise do nothing.
    const msg = this.codec.encodeKeyboardInput(code, state);
    if (msg) this.send(msg);
  }

  sendClipboardData(clipboardData: ClipboardData) {
    this.send(this.codec.encodeClipboardData(clipboardData));
  }

  sendWebAuthn(data: WebauthnAssertionResponse) {
    const msg = this.codec.encodeMfaJson({
      mfaType: 'n',
      jsonString: JSON.stringify(data),
    });
    this.send(msg);
  }

  addSharedDirectory(sharedDirectory: FileSystemDirectoryHandle) {
    try {
      this.sdManager.add(sharedDirectory);
    } catch (err) {
      this.handleError(err);
    }
  }

  sendSharedDirectoryAnnounce() {
    this.send(
      this.codec.encodeSharedDirectoryAnnounce({
        completionId: 0, // This is always the first request.
        // Hardcode directoryId for now since we only support sharing 1 directory.
        // We're using 2 because the smartcard device is hardcoded to 1 in the backend.
        directoryId: 2,
        name: this.sdManager.getName(),
      })
    );
  }

  sendSharedDirectoryInfoResponse(res: SharedDirectoryInfoResponse) {
    this.send(this.codec.encodeSharedDirectoryInfoResponse(res));
  }

  sendSharedDirectoryListResponse(res: SharedDirectoryListResponse) {
    this.send(this.codec.encodeSharedDirectoryListResponse(res));
  }

  sendSharedDirectoryReadResponse(response: SharedDirectoryReadResponse) {
    this.send(this.codec.encodeSharedDirectoryReadResponse(response));
  }

  resize(spec: ClientScreenSpec) {
    this.send(this.codec.encodeClientScreenSpec(spec));
  }

  // Emits an TdpClientEvent.ERROR event. Sets this.errored to true to alert the socket.onclose handler that
  // it needn't emit a generic unknown error event.
  private handleError(err: Error) {
    this.logger.error(err);
    this.emit(TdpClientEvent.TDP_ERROR, err);
    this.socket?.close();
  }

  // Ensures full cleanup of this object.
  // Note that it removes all listeners first and then cleans up the socket,
  // so don't call this if your calling object is relying on listeners.
  // It's safe to call this multiple times, calls subsequent to the first call
  // will simply do nothing.
  nuke() {
    this.removeAllListeners();
    this.socket?.close();
  }
}
