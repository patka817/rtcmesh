import Peer from 'peerjs';

const MESH_EVENT_RECIEVED_DATA = 'data';
const MESH_EVENT_PEER_CONNECTED = 'peer-connected';
const MESH_EVENT_PEER_DISCONNECTED = 'peer-disconnected';

const MESH_EVENT_DISCONNECT = 'disconnected';
const MESH_EVENT_ERROR = 'error';
const MESH_EVENT_CLOSE = 'close';
const MESH_EVENT_OPEN = 'open';
const MESH_EVENT_DESTROYED = 'destroyed';

export const Events = {
    RECIEVED_DATA: MESH_EVENT_RECIEVED_DATA,
    PEER_CONNECTED: MESH_EVENT_PEER_CONNECTED,
    PEER_DISCONNECTED: MESH_EVENT_PEER_DISCONNECTED,

    DISCONNECTED: MESH_EVENT_DISCONNECT,
    ERROR: MESH_EVENT_ERROR,
    CLOSE: MESH_EVENT_CLOSE,
    OPEN: MESH_EVENT_OPEN,
    DESTROYED: MESH_EVENT_DESTROYED
};

const MESH_ACTION_ADD_PEER = 'MAP';

export class Mesh {
    _myPeer = null;
    _connectedPeers = new Map();
    _pendingPeers = new Map();
    _pendingPeersCallbacks = new Map();
    _eventCallbacks = new Map();

    constructor(id) {
        this.initialize(id);
    }

    initialize = (id) => {
        this._myPeer = id ? (new Peer(id)) : (new Peer());
        this._myPeer.on('open', this._onOpen);
        this._myPeer.on('close', this._onClose);
        this._myPeer.on('disconnected', this._onDisconnected);
        this._myPeer.on('error', this._onError);
        this._myPeer.on('connection', this._onDataConnection);
        this._myPeer.connect();
    };

    destroy = () => {
        if (this._myPeer.destroyed === false) {
            this._myPeer.destroy();
        } else {
            this._myPeer = null;
            this._emitEvent(MESH_EVENT_DESTROYED);
            this._pendingPeersCallbacks.forEach((callback) => { callback(false); });
            this._pendingPeersCallbacks.clear();
            this._connectedPeers.clear();
            this._pendingPeers.clear();
            this._eventCallbacks.clear();
        }
    };

    on = (tag, callback) => {
        this._eventCallbacks.set(tag, callback);
        if (tag === MESH_EVENT_OPEN && this._myPeer && this._myPeer.id && this._myPeer.disconnected === false) {
            callback(this._myPeer.id);
        } else if (tag === MESH_EVENT_DISCONNECT && this._myPeer && this._myPeer.id && this._myPeer.disconnected === true) {
            callback();
        }
    };

    broadcast = (payload) => {
        this._connectedPeers.forEach((peer, id) => {
            peer.send(payload);
        });
    };

    sendTo = (id, payload) => {
        let meshPeer = this._connectedPeers.get(id);
        if (meshPeer) {
            meshPeer.send(payload);
        } else {
            throw Error('Missing peer with id ' + id);
        }
    };

    allPeers = () => {
        return [...this._connectedPeers.values()];
    }

    connectToPeer = (peerId) => {
        return new Promise((resolve, reject) => {
            const connected = this._connectedPeers.has(peerId);
            if (connected) {
                resolve();
            } else {
                this._initiateConnection(peerId).then(resolve).catch(reject);
            }
        }); 
    };

    _initiateConnection = (peerId) => {
        return new Promise((resolve, reject) => {
            const pending = this._pendingPeers.has(peerId);
                if (!pending) {
                    let meshPeer = new MeshPeer(this);
                    this._pendingPeers.set(peerId, meshPeer);
                    let connection = this._myPeer.connect(peerId, { serialization: 'json' });
                    meshPeer.updateConnection(connection);
                }

                if (this._pendingPeersCallbacks.has(peerId) === false) {
                    this._pendingPeersCallbacks.set(peerId, []);
                }

                this._pendingPeersCallbacks.get(peerId).push((connected) => {
                    if (connected) {
                        resolve();
                    } else {
                        reject();
                    }
                });
        });
    };

    removePeer = (peerId) => {
        if (this._connectedPeers.has(peerId)) {
            console.log(`${this._myPeer.id} removing peer: ${peerId}`);
            const peer = this._connectedPeers.get(peerId);
            this._connectedPeers.delete(peerId);
            peer.destroy();
            this._emitEvent(MESH_EVENT_PEER_DISCONNECTED, peerId);
        } else if (this._pendingPeers.delete(peerId)) {
            console.log('removed pending peer');
            this._pendingPeersCallbacks.delete(peerId);
        }
    };

    removeAll = () => {
        this._pendingPeers.forEach(p => { p.destroy(); } );
        this._pendingPeers.clear();
        this._pendingPeersCallbacks.clear();
        this._connectedPeers.forEach(p => { p.destroy(); } );
        this._connectedPeers.clear();
    };

    _peerOpen = (peerId) => {
        if (!this._pendingPeers.has(peerId)) {
            console.error('Missing peerId among pending peers');
        } else {
            const peer = this._pendingPeers.get(peerId);
            this._pendingPeers.delete(peerId);
            this._connectedPeers.set(peerId, peer);
            if (this._pendingPeersCallbacks.get(peerId)) {
                this._pendingPeersCallbacks.get(peerId).forEach(c => { c(true); });
                this._pendingPeersCallbacks.delete(peerId);
            }

            let payload = { meshAction: MESH_ACTION_ADD_PEER, peerId: peerId };
            this.broadcast(payload);
        }

        if (this._connectedPeers.has(peerId)) {
            this._emitEvent(MESH_EVENT_PEER_CONNECTED, peerId);
        }
    }

    _recievedData = (data, peerId) => {
        if (this._isMeshData(data)) {
            const { meshAction, peerId } = data;
            if (!peerId || !meshAction) {
                console.error('Missing peerId/action from data: ' + JSON.stringify(data));
                return;
            }
            if (meshAction === MESH_ACTION_ADD_PEER) {
                this.connectToPeer(peerId);
            } else {
                console.error('Invalid action sent with mesh-data: ' + JSON.stringify(data));
            }
        } else {
            this._emitEvent(MESH_EVENT_RECIEVED_DATA, { peerId, data });
        }
    }

    _isMeshData = (data) => {
        return typeof(data) === 'object' && ('meshAction' in data) && data.meshAction === MESH_ACTION_ADD_PEER;
    };

    _onDataConnection = (dataConnection) => {
        const remotePeerId = dataConnection.peer;
        if (this._connectedPeers.has(remotePeerId)) {
            // This shouldn't happen, not often..
            const meshPeer = this._connectedPeers.get(remotePeerId);
            meshPeer.updateConnection(dataConnection);
        } else {
            const meshPeer = new MeshPeer(this, dataConnection);
            this._pendingPeers.set(remotePeerId, meshPeer);
        }
    };

    _onOpen = (id) => {
        console.log('Connected to Peer-server with id: ' + id);
        this._emitEvent(MESH_EVENT_OPEN, id);
    };

    _onDisconnected = () => {
        this._emitEvent(MESH_EVENT_DISCONNECT);
        this._myPeer._reconnect();
    };

    _onError = (error) => {
        this._emitEvent(MESH_EVENT_ERROR, error);
        // TODO: will probably need to handle more errors better... 
        if (error.type !== 'unavailable-id') {
            //this._myPeer.destroy();
        }
    };

    _onClose = () => {
        // _myPeer is destroyed
        this._emitEvent(MESH_EVENT_CLOSE);
        this.destroy();
    }

    _emitEvent = (event, arg) => {
        if (this._eventCallbacks.has(event)) {
            this._eventCallbacks.get(event)(arg);
        }
    };
}

class MeshPeer {
    _id = null;
    _dataConnection = null;
    _mesh = null;

    constructor(mesh, dataConnection) {
        this._mesh = mesh;
        if (dataConnection) {
            this.updateConnection(dataConnection);
        }
    }

    destroy = () => {
        this.mesh = null;
        this._dataConnection.close();
        this._dataConnection = null;
    };

    send = (payload) => {
        if (!this._dataConnection) {
            console.error(`Missing dataconnection for MeshPeer ${this._id} ?!?!`);
            return;
        } else if (this._dataConnection.open === false) {
            console.error('cannot send data, dataconnection is not open..');
            return;
        }
        this._dataConnection.send(payload);
    };

    updateConnection = (dataConnection) => {
        let prevId = null;
        if (this._dataConnection) {
            prevId = this._dataConnection.peer;
            this._dataConnection.close();
        }
        this._dataConnection = dataConnection;
        this._id = dataConnection.peer;
        if (prevId && prevId !== this._id) {
            console.error('Changed id when updated dataconnection, should not happen..');
        }

        this._dataConnection.on('open', this._onOpen);
        this._dataConnection.on('data', this._onData);
        this._dataConnection.on('close', this._onClose);
        this._dataConnection.on('error', this._onError);
    }

    _onOpen = () => {
        console.log('Ready to send/recieve data for peer ' + this._id);
        if (this._mesh) {
            this._mesh._peerOpen(this._id);
        }
    };

    _onData = (data) => {
        try {
            this._mesh._recievedData(data, this._id);
        } catch (error) {
            console.error(error);
        }
    };

    _onClose = () => {
        if (this._id && this._mesh) {
            this._mesh.removePeer(this._id);
        }
    };

    _onError = (error) => {
        console.error('DataConnection error: ' + JSON.stringify(error));
    };
}