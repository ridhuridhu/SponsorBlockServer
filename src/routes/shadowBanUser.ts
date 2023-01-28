import { db, privateDB } from "../databases/databases";
import { getHashCache } from "../utils/getHashCache";
import { Request, Response } from "express";
import { config } from "../config";
import { Category, HashedIP, Service, VideoID, VideoIDHash } from "../types/segments.model";
import { UserID } from "../types/user.model";
import { QueryCacher } from "../utils/queryCacher";
import { isUserVIP } from "../utils/isUserVIP";
import { parseCategories } from "../utils/parseParams";

export async function shadowBanUser(req: Request, res: Response): Promise<Response> {
    const userID = req.query.userID as UserID;
    const hashedIP = req.query.hashedIP as HashedIP;
    const adminUserIDInput = req.query.adminUserID as UserID;
    const type = req.query.type as string ?? "1";

    const enabled = req.query.enabled === undefined
        ? true
        : req.query.enabled === "true";

    //if enabled is false and the old submissions should be made visible again
    const unHideOldSubmissions = req.query.unHideOldSubmissions !== "false";

    const categories: Category[] = parseCategories(req, config.categoryList as Category[]);

    if (adminUserIDInput == undefined || (userID == undefined && hashedIP == undefined || !["1", "2"].includes(type))) {
        //invalid request
        return res.sendStatus(400);
    }

    //hash the userID
    const adminUserID = await getHashCache(adminUserIDInput);

    const isVIP = await isUserVIP(adminUserID);
    if (!isVIP) {
        //not authorized
        return res.sendStatus(403);
    }

    if (userID) {
        //check to see if this user is already shadowbanned
        const row = await db.prepare("get", `SELECT count(*) as "userCount" FROM "shadowBannedUsers" WHERE "userID" = ?`, [userID]);

        if (enabled && row.userCount == 0) {
            //add them to the shadow ban list

            //add it to the table
            await db.prepare("run", `INSERT INTO "shadowBannedUsers" VALUES(?)`, [userID]);

            //find all previous submissions and hide them
            if (unHideOldSubmissions) {
                await unHideSubmissionsByUser(categories, userID, type);
            }
        } else if (!enabled && row.userCount > 0) {
            //remove them from the shadow ban list
            await db.prepare("run", `DELETE FROM "shadowBannedUsers" WHERE "userID" = ?`, [userID]);

            //find all previous submissions and unhide them
            if (unHideOldSubmissions) {
                const segmentsToIgnore = (await db.prepare("all", `SELECT "UUID" FROM "sponsorTimes" st
                    JOIN "lockCategories" ns on "st"."videoID" = "ns"."videoID" AND st.category = ns.category AND "st"."service" = "ns"."service" WHERE "st"."userID" = ?`
                , [userID])).map((item: { UUID: string }) => item.UUID);
                const allSegments = (await db.prepare("all", `SELECT "UUID" FROM "sponsorTimes" st WHERE "st"."userID" = ?`, [userID]))
                    .map((item: { UUID: string }) => item.UUID);

                await Promise.all(allSegments.filter((item: { uuid: string }) => {
                    return segmentsToIgnore.indexOf(item) === -1;
                }).map(async (UUID: string) => {
                    // collect list for unshadowbanning
                    (await db.prepare("all", `SELECT "videoID", "hashedVideoID", "service", "votes", "views", "userID" FROM "sponsorTimes" WHERE "UUID" = ? AND "shadowHidden" >= 1 AND "category" in (${categories.map((c) => `'${c}'`).join(",")})`, [UUID]))
                        .forEach((videoInfo: { category: Category, videoID: VideoID, hashedVideoID: VideoIDHash, service: Service, userID: UserID }) => {
                            QueryCacher.clearSegmentCache(videoInfo);
                        }
                        );

                    return db.prepare("run", `UPDATE "sponsorTimes" SET "shadowHidden" = 0 WHERE "UUID" = ? AND "category" in (${categories.map((c) => `'${c}'`).join(",")})`, [UUID]);
                }));
            }
            // already shadowbanned
        } else if (enabled && row.userCount > 0) {
            // apply unHideOldSubmissions if applicable
            if (unHideOldSubmissions) {
                await unHideSubmissionsByUser(categories, userID, type);
                return res.sendStatus(200);
            }

            // otherwise ban already exists, send 409
            return res.sendStatus(409);
        }
    } else if (hashedIP) {
        //check to see if this user is already shadowbanned
        const row = await db.prepare("get", `SELECT count(*) as "userCount" FROM "shadowBannedIPs" WHERE "hashedIP" = ?`, [hashedIP]);

        if (enabled && row.userCount == 0) {
            //add them to the shadow ban list

            //add it to the table
            await db.prepare("run", `INSERT INTO "shadowBannedIPs" VALUES(?)`, [hashedIP]);

            //find all previous submissions and hide them
            if (unHideOldSubmissions) {
                await unHideSubmissionsByIP(categories, hashedIP, type);
            }
        } else if (!enabled) {
            if (row.userCount > 0) {
                //remove them from the shadow ban list
                await db.prepare("run", `DELETE FROM "shadowBannedIPs" WHERE "hashedIP" = ?`, [hashedIP]);
            }

            //find all previous submissions and unhide them
            if (unHideOldSubmissions) {
                await unHideSubmissionsByIP(categories, hashedIP, "0");
            }
        } else if (enabled && row.userCount > 0) {
            // apply unHideOldSubmissions if applicable
            if (unHideOldSubmissions) {
                await unHideSubmissionsByIP(categories, hashedIP, type);
                return res.sendStatus(200);
            }

            // otherwise ban already exists, send 409
            return res.sendStatus(409);
        }
    }
    return res.sendStatus(200);
}

async function unHideSubmissionsByUser(categories: string[], userID: UserID, type = "1") {
    if (!["1", "2"].includes(type)) return;

    await db.prepare("run", `UPDATE "sponsorTimes" SET "shadowHidden" = ${type} WHERE "userID" = ? AND "category" in (${categories.map((c) => `'${c}'`).join(",")})
                    AND NOT EXISTS ( SELECT "videoID", "category" FROM "lockCategories" WHERE
                    "sponsorTimes"."videoID" = "lockCategories"."videoID" AND "sponsorTimes"."service" = "lockCategories"."service" AND "sponsorTimes"."category" = "lockCategories"."category")`, [userID]);

    // clear cache for all old videos
    (await db.prepare("all", `SELECT "videoID", "hashedVideoID", "service", "votes", "views" FROM "sponsorTimes" WHERE "userID" = ?`, [userID]))
        .forEach((videoInfo: { category: Category; videoID: VideoID; hashedVideoID: VideoIDHash; service: Service; userID: UserID; }) => {
            QueryCacher.clearSegmentCache(videoInfo);
        });
}

async function unHideSubmissionsByIP(categories: string[], hashedIP: HashedIP, type = "1") {
    if (!["0", "1", "2"].includes(type)) return;

    const submissions = await privateDB.prepare("all", `SELECT "timeSubmitted" FROM "sponsorTimes" WHERE "hashedIP" = ?`, [hashedIP]) as { timeSubmitted: number }[];

    await Promise.all(submissions.map(async (submission) => {
        (await db.prepare("all", `SELECT "videoID", "hashedVideoID", "service", "votes", "views", "userID" FROM "sponsorTimes" WHERE "timeSubmitted" = ? AND "shadowHidden" >= 1 AND "category" in (${categories.map((c) => `'${c}'`).join(",")})`, [submission.timeSubmitted]))
            .forEach((videoInfo: { category: Category, videoID: VideoID, hashedVideoID: VideoIDHash, service: Service, userID: UserID }) => {
                QueryCacher.clearSegmentCache(videoInfo);
            }
            );

        await db.prepare("run", `UPDATE "sponsorTimes" SET "shadowHidden" = ${type} WHERE "timeSubmitted" = ? AND "category" in (${categories.map((c) => `'${c}'`).join(",")})
            AND NOT EXISTS ( SELECT "videoID", "category" FROM "lockCategories" WHERE
            "sponsorTimes"."videoID" = "lockCategories"."videoID" AND "sponsorTimes"."service" = "lockCategories"."service" AND "sponsorTimes"."category" = "lockCategories"."category")`, [submission.timeSubmitted]);
    }));
}
