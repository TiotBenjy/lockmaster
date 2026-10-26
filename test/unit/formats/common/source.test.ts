import { BufferSource } from '../../../../src/formats/common/source.js';
import { describeByteSourceContract } from '../../../contracts/byte-source.contract.js';

describeByteSourceContract((content) => new BufferSource(content));
describeByteSourceContract((content) => new BufferSource(content, 1000));
