import React, { useEffect, useState } from 'react';
import { Divider, Header, Icon } from 'semantic-ui-react';
import CountUp from 'react-countup';

import { NewRoomButton, JeopardyTopBar } from '../TopBar/TopBar';
import styles from './Home.module.css';
import { serverPath } from '../../utils';

const Feature = ({
  icon,
  text,
  title,
}: {
  icon: string;
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
      <Icon fitted size="huge" name={icon as any} />
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
    }
    update();
  }, []);
  return (
    <div className={`${styles.hero} ${color === 'green' ? styles.green : ''}`}>
      <div className={styles.heroInner}>
        <div style={{ padding: '30px', flex: '1 1 0' }}>
          <div className={styles.heroText}>{heroText}</div>
          <div className={styles.subText}>
            <CountUp start={8000} end={epCount} delay={0} duration={3} />
            {' '}
            episodes featuring
            {' '}
            <CountUp start={500000} end={qCount} delay={0} duration={3} />
            {' '}
            clues
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
        <Divider horizontal>
          <Header inverted as="h4">
            <Icon name="cogs" />
            Features
          </Header>
        </Divider>
        <div className={styles.featureSection}>
          <Feature
            icon="hand point right"
            title="Episode Selector"
            text="Pick any episode by number, or play a random game."
          />
          <Feature
            icon="lightbulb"
            title="Buzzer"
            text="Implements the buzzer logic from the TV show (first correct answer scores points)"
          />
          <Feature
            icon="microphone"
            title="Reading"
            text="Clues are read to you by the computer for a realistic experience."
          />
          <Feature
            icon="gavel"
            title="Judging"
            text="Players perform answer judging themselves, so you're not penalized for incorrect spelling."
          />
          <Feature
            icon="wrench"
            title="Custom Games"
            text="Upload your own data file to play a custom game"
          />
        </div>
      </div>
    </div>
  );
};
