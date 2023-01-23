import React, { useRef } from "react";
import { ConnectionStatus, DbConnection, SequenceValue } from "driftdb"
import { Api, RoomResult } from "driftdb/dist/api"

const ROOM_ID_KEY = "_driftdb_room"
const CLIENT_ID_KEY = "_driftdb_client_id"

export const DatabaseContext = React.createContext<DbConnection | null>(null);

export function useDatabase(): DbConnection {
    const db = React.useContext(DatabaseContext);
    if (db === null) {
        throw new Error("useDatabase must be used within a DriftDBProvider");
    }
    return db;
}

export function useSharedState<T>(key: string, initialValue: T): [T, (value: T) => void] {
    const db = useDatabase();
    const [state, setState] = React.useState<T>(initialValue);

    const setStateOptimistic = (value: T) => {
        setState(value);
        db?.send({ type: "Push", action: { "type": "Replace" }, value, key: [key] });
    };

    React.useEffect(() => {
        const callback = (value: SequenceValue) => {
            setState(value.value as T);
        };
        db?.subscribe([key], callback);
        return () => {
            db?.unsubscribe([key], callback);
        };
    }, [db, key]);

    return [state, setStateOptimistic];
}

export function useUniqueClientId(): string {
    const currentId = useRef<string>()
    
    if (typeof window === "undefined") {
        return null!
    }

    if (!currentId.current) {
        if (sessionStorage.getItem(CLIENT_ID_KEY)) {
            currentId.current = sessionStorage.getItem(CLIENT_ID_KEY)!
        } else {
            currentId.current = crypto.randomUUID()
            sessionStorage.setItem(CLIENT_ID_KEY, currentId.current)
        }
    }
    return currentId.current
}

export function useSharedReducer<T, A>(key: string, reducer: (state: T, action: A) => T, initialValue: T, sizeThreshold: number = 5): [T, (action: A) => void] {
    const db = useDatabase();
    const [state, setState] = React.useState<T>(structuredClone(initialValue));
    const lastConfirmedState = React.useRef<T>(initialValue);
    const lastConfirmedSeq = React.useRef<number>(0);

    const dispatch = (action: any) => {
        const value = reducer(state, action);
        setState(value);
        db?.send({ type: "Push", action: { "type": "Append" }, value: { "apply": action }, key: [key] });
    };

    React.useEffect(() => {
        const callback = (sequenceValue: SequenceValue) => {
            if (sequenceValue.seq <= lastConfirmedSeq.current!) {
                return;
            }

            if (sequenceValue.value.reset !== undefined) {
                lastConfirmedState.current = sequenceValue.value.reset as T;
                lastConfirmedSeq.current = sequenceValue.seq;
                setState(structuredClone(lastConfirmedState.current));
                return;
            }

            if (sequenceValue.value.apply !== undefined) {
                lastConfirmedState.current = reducer(lastConfirmedState.current, sequenceValue.value.apply as A);
                lastConfirmedSeq.current = sequenceValue.seq;
                setState(structuredClone(lastConfirmedState.current));
                return;
            }

            console.log("Unknown message", sequenceValue.value)
        };
        const sizeCallback = (size: number) => {
            if (size > sizeThreshold && lastConfirmedSeq.current !== null) {
                db?.send({
                    type: "Push",
                    action: { "type": "Compact", seq: lastConfirmedSeq.current },
                    value: { "reset": lastConfirmedState.current },
                    key: [key]
                });
            }
        }

        db?.subscribe([key], callback, sizeCallback);
        return () => {
            db?.unsubscribe([key], callback);
        };
    }, [db, key, reducer, sizeThreshold]);

    return [state, dispatch];
}

export function useConnectionStatus(): ConnectionStatus {
    const db = useDatabase();
    const [status, setStatus] = React.useState<ConnectionStatus>({ connected: false });

    React.useEffect(() => {
        const callback = (event: ConnectionStatus) => {
            setStatus(event);
        };
        db?.statusListener.addListener(callback);
        return () => {
            db?.statusListener.removeListener(callback);
        };
    }, [db]);

    return status;
}

export function StatusIndicator() {
    const status = useConnectionStatus();

    let color
    if (status.connected) {
        color = "green"
    } else {
        color = "red"
    }

    return (
        <div style={{display: 'inline-block', border: '1px solid #ccc', background: '#eee', borderRadius: 10, padding: 10}}>
            DriftDB status: <span style={{color, fontWeight: 'bold'}}>{status.connected ? "Connected" : "Disconnected"}</span>
            {
                status.connected ? <>{" "}<span><a target="_blank" rel="noreferrer" style={{textDecoration: 'none', color: '#aaa', fontSize: "70%"}} href={status.debugUrl}>(ui)</a></span></> : null
            }
        </div>
    );
}

interface DriftDBProviderProps {
    children: React.ReactNode
    api: string
}

export function DriftDBProvider(props: DriftDBProviderProps) {
    const dbRef = React.useRef<DbConnection | null>(null);
    if (dbRef.current === null) {
        dbRef.current = new DbConnection();
    }

    React.useEffect(() => {
        let api = new Api(props.api);

        const searchParams = new URLSearchParams(window.location.search);
        let roomId = (
            searchParams.get(ROOM_ID_KEY) ??
            sessionStorage.getItem(ROOM_ID_KEY) ??
            null);

        let promise
        if (roomId) {
            promise = api.getRoom(roomId)
        } else {
            promise = api.newRoom()
        }

        promise.then((result: RoomResult) => {
            let url = new URL(window.location.href);
            url.searchParams.set(ROOM_ID_KEY, result.room);
            window.history.replaceState({}, "", url.toString());

            dbRef.current?.connect(result.url);
        });

        return () => {
            dbRef.current?.disconnect();
        }
    }, []);

    return <DatabaseContext.Provider value={dbRef.current}>{props.children}</DatabaseContext.Provider>;
}