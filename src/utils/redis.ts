import { config } from "../config";
import { Logger } from "./logger";
import redis, { Callback } from "redis";

interface RedisSB {
    get(key: string, callback?: Callback<string | null>): void;
    getAsync?(key: string): Promise<{err: Error | null, reply: string | null}>;
    set(key: string, value: string, callback?: Callback<string | null>): void;
    setAsync?(key: string, value: string): Promise<{err: Error | null, reply: string | null}>;
    delAsync?(...keys: [string]): Promise<Error | null>;
    close?(flush?: boolean): void;
    increment?(key: string): Promise<{err: Error| null, replies: any[] | null}>;
}

let exportObject: RedisSB = {
    get: (key, callback?) => callback(null, undefined),
    getAsync: () =>
        new Promise((resolve) => resolve({ err: null, reply: undefined })),
    set: (key, value, callback) => callback(null, undefined),
    setAsync: () =>
        new Promise((resolve) => resolve({ err: null, reply: undefined })),
    delAsync: () =>
        new Promise((resolve) => resolve(null)),
    increment: () =>
        new Promise((resolve) => resolve({ err: null, replies: undefined })),
};

if (config.redis) {
    Logger.info("Connected to redis");
    const client = redis.createClient(config.redis);
    exportObject = client;

    exportObject.getAsync = (key) => new Promise((resolve) => client.get(key, (err, reply) => resolve({ err, reply })));
    exportObject.setAsync = (key, value) => new Promise((resolve) => client.set(key, value, (err, reply) => resolve({ err, reply })));
    exportObject.delAsync = (...keys) => new Promise((resolve) => client.del(keys, (err) => resolve(err)));
    exportObject.close    = (flush) => client.end(flush);
    exportObject.increment = (key) => new Promise((resolve) =>
        client.multi()
            .incr(key)
            .expire(key, 60)
            .exec((err, replies) => resolve({ err, replies }))
    );
    client.on("error", function(error) {
        Logger.error(error);
    });
}

export default exportObject;
