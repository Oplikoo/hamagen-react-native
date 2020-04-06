import BackgroundTimer from 'react-native-background-timer';
import AsyncStorage from '@react-native-community/async-storage';
import moment from 'moment';
import {
  UserLocationsDatabase,
  IntersectionSickDatabase,
} from '../database/Database';
import { Exposure, Location, SickJSON } from '../types';
import { registerLocalNotification } from './PushService';
import { setExposures } from '../actions/ExposuresActions';
import { onError } from './ErrorService';
import { initLocale } from '../actions/LocaleActions';
import config from '../config/config';
import store from '../store';
import { LAST_FETCH_TS } from '../constants/Constants';

// tslint:disable-next-line:no-var-requires
const haversine = require('haversine');

export const startForegroundTimer = async () => {
  await checkSickPeople();

  BackgroundTimer.runBackgroundTimer(async () => {
    await checkSickPeople();
  }, config().sampleInterval);
};

export const queryDB = async () => {
  const db = new UserLocationsDatabase();
  const rows = await db.listSamples();
  return rows;
};

export const checkSickPeopleFromFile = async () => {
  try {
    const myData = await queryDB();
    const jsonFromFile = store().getState().exposures.points;

    const sickPeopleIntersected: any = getIntersectingSickRecords(myData, jsonFromFile.points);
    if (sickPeopleIntersected.length > 0) {
      onSickPeopleNotify(sickPeopleIntersected);
    }
  } catch (e) {
    console.log(e);
  }
};

export const checkSickPeople = async () => {
  const lastFetch = JSON.parse(
    (await AsyncStorage.getItem(LAST_FETCH_TS)) || '0',
  );

  // prevent excessive calls to checkSickPeople
  if (lastFetch && moment().valueOf() - lastFetch < config().fetchMilliseconds) {
    return;
  }

  fetch(`${config().dataUrl_utc}?r=${Math.random()}`, { headers: { 'Content-Type': 'application/json;charset=utf-8' } })
    .then(response => response.json())
    .then(async (responseJson) => {
      const myData = await queryDB();

      const sickPeopleIntersected: any = getIntersectingSickRecords(
        myData,
        responseJson,
      );

      if (sickPeopleIntersected.length > 0) {
        await onSickPeopleNotify(sickPeopleIntersected);
      }

      await AsyncStorage.setItem(
        LAST_FETCH_TS,
        JSON.stringify(moment().valueOf()),
      );
    })
    .catch((error) => {
      onError(error);
    });
};

export const getIntersectingSickRecords = (
  myData: Location[],
  sickRecordsJson: SickJSON,
) => {
  const sickPeopleIntersected: any = [];

  if (myData.length === 0) {
    console.log('Could not find data');
  } else {
    // for each feature in json data
    sickRecordsJson.features.map((sickRecord: Exposure) => {
      // for each raw in user data
      myData.reverse().forEach((userRecord: Location) => {
        if (
          isTimeOverlapping(userRecord, sickRecord)
          && isSpaceOverlapping(userRecord, sickRecord)
        ) {
          // add sick people you intersects
          sickRecord.properties.fromTime_utc = Math.max(userRecord.startTime, sickRecord.properties.fromTime_utc);
          sickRecord.properties.toTime_utc = userRecord.endTime;
          sickPeopleIntersected.push(sickRecord);
        }
      });
    });
  }

  return sickPeopleIntersected;
};

const checkMillisecondsDiff = (to: number, from: number) => {
  return to - from > config().intersectMilliseconds;
};

export const isTimeOverlapping = (userRecord: Location, sickRecord: Exposure) => {
  return checkMillisecondsDiff(
    Math.min(userRecord.endTime, sickRecord.properties.toTime_utc),
    Math.max(userRecord.startTime, sickRecord.properties.fromTime_utc)
  );
};

export const isSpaceOverlapping = ({ lat, long }: Location, { properties: { radius }, geometry: { coordinates } }: Exposure) => {
  const start = {
    latitude: lat,
    longitude: long,
  };

  const end = {
    latitude: coordinates[config().sickGeometryLatIndex],
    longitude: coordinates[config().sickGeometryLongIndex],
  };

  return haversine(start, end, { threshold: radius || config().meterRadius, unit: config().bufferUnits });
};

export const onSickPeopleNotify = async (sickPeopleIntersected: Exposure[]) => {
  try {
    const dbSick = new IntersectionSickDatabase();

    const exposuresToUpdate = [];

    for (const currSick of sickPeopleIntersected) {
      const queryResult = await dbSick.containsObjectID(
        currSick.properties.Key_Field,
      );

      if (!queryResult) {
        currSick.properties.fromTime = currSick.properties.fromTime_utc;
        currSick.properties.toTime = currSick.properties.toTime_utc;
        currSick.properties.OBJECTID = currSick.properties.Key_Field;

        exposuresToUpdate.push(currSick);
        await dbSick.addSickRecord(currSick);
      }
    }

    store().dispatch(setExposures(exposuresToUpdate));

    const { locale, notificationData } = await store().dispatch(initLocale());

    exposuresToUpdate.length > 0 && await registerLocalNotification(
      notificationData.sickMessage[locale].title,
      notificationData.sickMessage[locale].body,
      notificationData.sickMessage.duration,
      'ms',
    );
  } catch (error) {
    onError({ error });
  }
};
