import React, { useEffect, useState } from 'react';
import CountUp from 'react-countup';

import { NewRoomButton, JeopardyTopBar } from '../TopBar/TopBar';
import styles from './Home.module.css';
import { serverPath } from '../../utils';
import {
  IconBulb,
  IconGavel,
  IconHandFinger,
  IconMicrophoneFilled,
  IconTool,
} from '@tabler/icons-react';

const Feature = ({
  Icon,
  text,
  title,
}: {
  Icon: React.ForwardRefExoticComponent<any>;
  text: string;
  title: string;
}) => {
  return (
    <div
      style={{
        display: 'flex',
        flex: '1 1 0px',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '10px',
        minWidth: '180px',
      }}
    >
      {<Icon size={80} />}
      <h4 className={styles.featureTitle}>{title}</h4>
      <div className={styles.featureText}>{text}</div>
    </div>
  );
};

const Hero = ({
  heroText,
  action,
  image,
  color,
}: {
  heroText?: string;
  action?: React.ReactNode;
  image?: string;
  color?: string;
}) => {
  const [epCount, setEpCount] = useState(8000);
  const [qCount, setQCount] = useState(500000);
  useEffect(() => {
    const update = async () => {
      const response = await fetch(serverPath + '/metadata');
      const json = await response.json();
      setQCount(json.qs);
      setEpCount(json.eps);
    };
    update();
  }, []);
  return (
    <div className={`${styles.hero} ${color === 'green' ? styles.green : ''}`}>
      <div className={styles.heroInner}>
        <div style={{ padding: '30px', flex: '1 1 0' }}>
          <div className={styles.heroText}>{heroText}</div>
          <div className={styles.subText}>
            <CountUp start={9000} end={epCount} delay={0} duration={3} />{' '}
            episodes featuring{' '}
            <CountUp start={600000} end={qCount} delay={0} duration={3} /> clues
          </div>
          {action}
        </div>
        <div
          style={{
            flex: '1 1 0',
          }}
        >
          <img
            alt="hero"
            style={{ width: '100%', borderRadius: '10px' }}
            src={image}
          />
        </div>
      </div>
    </div>
  );
};

export const JeopardyHome = () => {
  return (
    <div>
      <JeopardyTopBar hideNewRoom />
      <div className={styles.container}>
        <Hero
          heroText={'Play Jeopardy! online with friends.'}
          action={<NewRoomButton />}
          image={'/screenshot3.png'}
        />
        <div className={styles.featureSection}>
          <Feature
            Icon={IconHandFinger}
            title="Episode Selector"
            text="Pick any episode by number, or play a random game."
          />
          <Feature
            Icon={IconBulb}
            title="Buzzer"
            text="Implements the buzzer logic from the TV show (first correct answer scores points)"
          />
          <Feature
            Icon={IconMicrophoneFilled}
            title="Reading"
            text="Clues are read to you by the computer for a realistic experience."
          />
          <Feature
            Icon={IconGavel}
            title="Judging"
            text="Players perform answer judging themselves, so you're not penalized for incorrect spelling."
          />
          <Feature
            Icon={IconTool}
            title="Custom Games"
            text="Upload your own data file to play a custom game"
          />
        </div>
      </div>
    </div>
  );
};
